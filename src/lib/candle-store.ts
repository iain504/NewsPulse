/**
 * Candle store — every candle read in the app goes through here.
 *
 * Reads are served from the local `Kline` table, which the Binance WebSocket
 * feed (market-feed.ts) keeps live. Historical bootstrap happens at most once
 * per (symbol, interval) and tries, in order:
 *   1. Binance REST (governed — only when not banned / within budget)
 *   2. Bybit public spot API
 *   3. OKX public API
 * so indicators and charts keep working even while Binance REST is banned.
 */

import { db } from "@/lib/db";
import { fetchKlines, type BinanceInterval, type Kline } from "@/lib/binance";
import { ensureSymbols, getLiveCandle, intervalSeconds } from "@/lib/market-feed";

/** minimum gap between bootstrap attempts for the same symbol+interval */
const BOOTSTRAP_THROTTLE_MS = 30_000;

const bootstrapThrottle = new Map<string, number>();

export interface CandlesResult {
  candles: Kline[];
  /** where the bulk of the data came from this call */
  source: "cache" | "cache+bootstrap" | "partial";
  /** true when the newest candle is older than 2 intervals (feed down / warming up) */
  stale: boolean;
}

function klineFromRow(row: {
  openTimeSec: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
  trades: number;
}, intervalSec: number): Kline {
  const openMs = row.openTimeSec * 1000;
  return {
    openTime: openMs,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    closeTime: openMs + intervalSec * 1000 - 1,
    quoteVolume: row.quoteVolume,
    trades: row.trades,
  };
}

async function readRows(symbol: string, interval: string, limit: number): Promise<Kline[]> {
  const rows = await db.kline.findMany({
    where: { symbol: symbol.toUpperCase(), interval },
    orderBy: { openTimeSec: "desc" },
    take: limit,
  });
  rows.reverse();
  return rows.map((r) => klineFromRow(r, intervalSeconds(interval)));
}

// ---------------------------------------------------------------------------
// bootstrap sources (all free, no keys, newest-first lists)
// ---------------------------------------------------------------------------

async function upsertAll(symbol: string, interval: string, bars: Kline[]): Promise<void> {
  for (const b of bars) {
    const openTimeSec = Math.floor(b.openTime / 1000);
    await db.kline.upsert({
      where: { symbol_interval_openTimeSec: { symbol: symbol.toUpperCase(), interval, openTimeSec } },
      create: {
        symbol: symbol.toUpperCase(),
        interval,
        openTimeSec,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        quoteVolume: b.quoteVolume,
        trades: b.trades,
      },
      update: {
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        quoteVolume: b.quoteVolume,
        trades: b.trades,
      },
    });
  }
}

const BYBIT_INTERVAL: Record<string, string> = { "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "D" };
const OKX_BAR: Record<string, string> = { "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D" };

async function bootstrapFromBybit(symbol: string, interval: BinanceInterval, limit: number): Promise<boolean> {
  const iv = BYBIT_INTERVAL[interval];
  if (!iv) return false;
  const url =
    `https://api.bybit.com/v5/market/kline?category=spot&symbol=${encodeURIComponent(symbol)}` +
    `&interval=${iv}&limit=${Math.min(1000, Math.max(limit, 60))}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) return false;
    const json = (await res.json()) as {
      retCode?: number;
      result?: { list?: string[][] };
    };
    const list = json.result?.list ?? [];
    if (json.retCode !== 0 || list.length === 0) return false;
    const bars: Kline[] = list
      .map((row) => {
        const openTime = Number(row[0]);
        return {
          openTime,
          open: Number(row[1]),
          high: Number(row[2]),
          low: Number(row[3]),
          close: Number(row[4]),
          volume: Number(row[5]),
          closeTime: openTime + intervalSeconds(interval) * 1000 - 1,
          quoteVolume: Number(row[6]) || 0,
          trades: 0,
        };
      })
      .filter((b) => Number.isFinite(b.openTime) && b.close > 0)
      .sort((a, b) => a.openTime - b.openTime);
    if (bars.length === 0) return false;
    await upsertAll(symbol, interval, bars);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function bootstrapFromOkx(symbol: string, interval: BinanceInterval, limit: number): Promise<boolean> {
  const bar = OKX_BAR[interval];
  if (!bar || !symbol.endsWith("USDT")) return false;
  const instId = `${symbol.slice(0, -4)}-USDT`;
  const url =
    `https://www.okx.com/api/v5/market/candles?instId=${encodeURIComponent(instId)}` +
    `&bar=${bar}&limit=${Math.min(300, Math.max(limit, 60))}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) return false;
    const json = (await res.json()) as { code?: string; data?: string[][] };
    const list = json.data ?? [];
    if (json.code !== "0" || list.length === 0) return false;
    const bars: Kline[] = list
      .map((row) => {
        const openTime = Number(row[0]);
        return {
          openTime,
          open: Number(row[1]),
          high: Number(row[2]),
          low: Number(row[3]),
          close: Number(row[4]),
          volume: Number(row[5]),
          closeTime: openTime + intervalSeconds(interval) * 1000 - 1,
          quoteVolume: Number(row[7]) || 0,
          trades: 0,
        };
      })
      .filter((b) => Number.isFinite(b.openTime) && b.close > 0)
      .sort((a, b) => a.openTime - b.openTime);
    if (bars.length === 0) return false;
    await upsertAll(symbol, interval, bars);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Top-up history for symbol+interval when the cache is thin or stale.
 * Returns which source (if any) provided data.
 */
async function bootstrap(
  symbol: string,
  interval: BinanceInterval,
  limit: number,
): Promise<"binance" | "bybit" | "okx" | null> {
  const key = `${symbol}|${interval}`;
  const now = Date.now();
  const last = bootstrapThrottle.get(key) ?? 0;
  if (now - last < BOOTSTRAP_THROTTLE_MS) return null;
  bootstrapThrottle.set(key, now);

  // 1) Binance REST — governed + ban-aware; skipped while the IP is refused
  try {
    const bars = await fetchKlines(symbol, interval, Math.min(500, Math.max(limit, 60)));
    if (bars.length > 0) {
      await upsertAll(symbol, interval, bars);
      return "binance";
    }
  } catch {
    // banned / budget exhausted / unreachable → next source
  }

  // 2) Bybit spot
  if (await bootstrapFromBybit(symbol, interval, limit)) return "bybit";

  // 3) OKX spot
  if (await bootstrapFromOkx(symbol, interval, limit)) return "okx";

  return null;
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * Get the newest `limit` candles for symbol+interval from the local cache.
 * Ensures the WebSocket feed is subscribed; bootstraps history once when the
 * cache is thin (REST sources, ban-aware). Never throws — returns whatever
 * data is available.
 */
export async function getCandles(
  symbol: string,
  interval: BinanceInterval,
  limit = 150,
): Promise<CandlesResult> {
  const sym = symbol.toUpperCase();
  const intervalSec = intervalSeconds(interval);

  ensureSymbols([sym]);

  let candles = await readRows(sym, interval, limit);
  let source: CandlesResult["source"] = "cache";
  let bootstrapped = false;

  const nowSec = Math.floor(Date.now() / 1000);
  const newestOpen = candles.length > 0 ? candles[candles.length - 1].openTime / 1000 : 0;
  const stale = candles.length === 0 || newestOpen < nowSec - 2 * intervalSec;

  if (candles.length < limit || stale) {
    const via = await bootstrap(sym, interval, limit);
    if (via) {
      bootstrapped = true;
      source = "cache+bootstrap";
      candles = await readRows(sym, interval, limit);
    }
  }

  // splice in the live (still open) candle straight from the WebSocket feed —
  // gives ~1s-fresh chart tips without waiting for the 5s DB flush
  const live = getLiveCandle(sym, interval);
  if (live && live.close > 0) {
    const last = candles[candles.length - 1];
    if (!last) {
      candles.push(live);
    } else if (live.openTime === last.openTime) {
      candles[candles.length - 1] = live;
    } else if (live.openTime > last.openTime) {
      candles.push(live);
    }
  }

  const enough = candles.length >= Math.min(limit, 60);
  if (bootstrapped && !enough) source = "partial";
  return { candles, source, stale: candles.length === 0 || (candles[candles.length - 1].openTime / 1000 < nowSec - 2 * intervalSec && !live) };
}
