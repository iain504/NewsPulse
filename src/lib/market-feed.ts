/**
 * Binance WebSocket market feed — the primary data source (server singleton).
 *
 * Streams (per watchlist symbol, zero request weight):
 *   - `<sym>@miniTicker`  → last price + 24h stats every 1s
 *   - `<sym>@kline_<iv>`  → live candles for every supported interval
 *
 * Candles are buffered in memory and flushed into the local `Kline` table
 * every 5s, so charts, scans and the engine read everything from cache and
 * Binance REST is never polled — which is what previously triggered the
 * "Way too much request weight used; IP banned" lockout.
 */

import WebSocket from "ws";
import { db } from "@/lib/db";
import { VALID_INTERVALS, type BinanceInterval, type Kline, type Ticker24h } from "@/lib/binance";

const WS_HOSTS = ["wss://stream.binance.com:9443/stream", "wss://data-stream.binance.vision/stream"];

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
const FLUSH_MS = 5_000;
const WATCHDOG_MS = 30_000;
/** a spot price older than this is considered stale (miniTicker ticks ~1s) */
const SPOT_FRESH_MS = 15_000;
/** a cached 24h-ticker older than this is dropped from feed lookups */
const TICKER_FRESH_MS = 120_000;
/** candle rows retained per (symbol, interval) */
const RETENTION_BARS = 700;
/** hard cap on the pending write buffer (memory safety) */
const PENDING_CAP = 4_000;

interface MiniTicker {
  symbol: string;
  lastPrice: number;
  openPrice: number;
  high: number;
  low: number;
  quoteVolume: number;
  updatedAt: number;
}

interface FeedKlineRow {
  openTimeSec: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
  trades: number;
}

interface FeedState {
  ws: WebSocket | null;
  hostIdx: number;
  connecting: boolean;
  lastMsgAt: number;
  attempt: number;
  reconnectTimer: NodeJS.Timeout | null;
  watchdog: NodeJS.Timeout | null;
  flushTimer: NodeJS.Timeout | null;
  subId: number;
  desired: Set<string>; // lowercase symbols we must stream
  streams: Set<string>; // stream names currently subscribed on the socket
  prices: Map<string, MiniTicker>; // by UPPER symbol
  live: Map<string, FeedKlineRow>; // key SYM|interval → newest candle
  pending: Map<string, FeedKlineRow>; // key SYM|interval|openTimeSec → row to upsert
  stats: { connects: number; reconnects: number; msgs: number; startedAt: number };
}

const g = globalThis as unknown as { __newspulseFeed?: FeedState };

function state(): FeedState {
  if (!g.__newspulseFeed) {
    g.__newspulseFeed = {
      ws: null,
      hostIdx: 0,
      connecting: false,
      lastMsgAt: 0,
      attempt: 0,
      reconnectTimer: null,
      watchdog: null,
      flushTimer: null,
      subId: 1,
      desired: new Set(),
      streams: new Set(),
      prices: new Map(),
      live: new Map(),
      pending: new Map(),
      stats: { connects: 0, reconnects: 0, msgs: 0, startedAt: Date.now() },
    };
  }
  return g.__newspulseFeed;
}

function streamsFor(symbolLower: string): string[] {
  return [`${symbolLower}@miniTicker`, ...VALID_INTERVALS.map((iv) => `${symbolLower}@kline_${iv}`)];
}

// ---------------------------------------------------------------------------
// connection lifecycle
// ---------------------------------------------------------------------------

function connect(): void {
  const s = state();
  if (s.ws || s.connecting) return;
  s.connecting = true;
  const url = WS_HOSTS[s.hostIdx % WS_HOSTS.length];

  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch {
    s.connecting = false;
    scheduleReconnect();
    return;
  }
  s.ws = ws;

  ws.on("open", () => {
    const st = state();
    st.connecting = false;
    st.lastMsgAt = Date.now();
    st.attempt = 0;
    st.stats.connects += 1;
    if (st.stats.connects > 1) st.stats.reconnects += 1;
    // (re)subscribe everything we want on this fresh socket
    st.streams = new Set();
    subscribeDesired();
    ensureTimers();
  });

  ws.on("message", (raw: WebSocket.RawData) => {
    const st = state();
    st.lastMsgAt = Date.now();
    st.stats.msgs += 1;
    try {
      const msg = JSON.parse(raw.toString()) as { stream?: string; data?: unknown };
      if (!msg.stream || msg.data === null || typeof msg.data !== "object") return;
      handleData(msg.stream, msg.data as Record<string, unknown>);
    } catch {
      // malformed frame — ignore
    }
  });

  const teardown = () => {
    const st = state();
    if (st.ws === ws) {
      st.ws = null;
      st.connecting = false;
      st.streams = new Set();
    }
    scheduleReconnect();
  };
  ws.on("error", teardown);
  ws.on("close", teardown);
}

function scheduleReconnect(): void {
  const s = state();
  if (s.reconnectTimer) return;
  const delay = BACKOFF_MS[Math.min(s.attempt, BACKOFF_MS.length - 1)];
  s.attempt += 1;
  s.hostIdx = (s.hostIdx + 1) % WS_HOSTS.length; // rotate hosts on each retry
  s.reconnectTimer = setTimeout(() => {
    s.reconnectTimer = null;
    if (s.desired.size > 0) connect();
  }, delay);
  s.reconnectTimer.unref?.();
}

function sendSub(action: "SUBSCRIBE" | "UNSUBSCRIBE", streams: string[]): void {
  const s = state();
  if (!s.ws || s.ws.readyState !== WebSocket.OPEN) return;
  try {
    s.ws.send(JSON.stringify({ method: action, params: streams, id: s.subId++ }));
  } catch {
    // socket died mid-send — reconnect path will resubscribe
  }
}

function subscribeDesired(): void {
  const s = state();
  const want: string[] = [];
  for (const sym of s.desired) for (const stream of streamsFor(sym)) if (!s.streams.has(stream)) want.push(stream);
  if (want.length === 0) return;
  sendSub("SUBSCRIBE", want);
  for (const w of want) s.streams.add(w);
}

function ensureTimers(): void {
  const s = state();
  if (!s.flushTimer) {
    s.flushTimer = setInterval(() => void flushPending(), FLUSH_MS);
    s.flushTimer.unref?.();
  }
  if (!s.watchdog) {
    s.watchdog = setInterval(() => {
      const st = state();
      // Binance pings/tick data arrive constantly — silence means a dead socket
      if (st.ws && Date.now() - st.lastMsgAt > 120_000) {
        try {
          st.ws.terminate();
        } catch {
          // already dead
        }
      }
    }, WATCHDOG_MS);
    s.watchdog.unref?.();
  }
}

// ---------------------------------------------------------------------------
// message handling
// ---------------------------------------------------------------------------

function handleData(stream: string, data: Record<string, unknown>): void {
  const s = state();
  const [symLower, kind] = stream.split("@");
  const symbol = symLower.toUpperCase();

  if (kind === "miniTicker") {
    const t = data as { c?: string; o?: string; h?: string; l?: string; q?: string };
    const lastPrice = Number(t.c);
    if (!Number.isFinite(lastPrice) || lastPrice <= 0) return;
    s.prices.set(symbol, {
      symbol,
      lastPrice,
      openPrice: Number(t.o) || lastPrice,
      high: Number(t.h) || lastPrice,
      low: Number(t.l) || lastPrice,
      quoteVolume: Number(t.q) || 0,
      updatedAt: Date.now(),
    });
    return;
  }

  if (kind?.startsWith("kline")) {
    const k = data.k as
      | { t?: number; o?: string; h?: string; l?: string; c?: string; v?: string; q?: string; n?: number; i?: string }
      | undefined;
    if (!k || typeof k.t !== "number" || !k.i) return;
    const iv = k.i as BinanceInterval;
    const row: FeedKlineRow = {
      openTimeSec: Math.floor(k.t / 1000),
      open: Number(k.o) || 0,
      high: Number(k.h) || 0,
      low: Number(k.l) || 0,
      close: Number(k.c) || 0,
      volume: Number(k.v) || 0,
      quoteVolume: Number(k.q) || 0,
      trades: Number(k.n) || 0,
    };
    const liveKey = `${symbol}|${iv}`;
    const prevLive = s.live.get(liveKey);
    // rolling OHLC safety: keep the extremes seen while the candle is open
    if (prevLive && prevLive.openTimeSec === row.openTimeSec) {
      row.high = Math.max(prevLive.high, row.high);
      row.low = Math.min(prevLive.low || row.low, row.low);
    }
    s.live.set(liveKey, row);
    const pendKey = `${symbol}|${iv}|${row.openTimeSec}`;
    s.pending.set(pendKey, row);
    if (s.pending.size > PENDING_CAP) {
      const oldest = s.pending.keys().next().value;
      if (oldest !== undefined) s.pending.delete(oldest);
    }
  }
}

// ---------------------------------------------------------------------------
// DB flush + retention
// ---------------------------------------------------------------------------

async function flushPending(): Promise<void> {
  const s = state();
  if (s.pending.size === 0) return;
  const entries = [...s.pending.entries()];
  s.pending.clear();

  try {
    for (const [key, row] of entries) {
      const [sym, iv] = key.split("|");
      if (!sym || !iv) continue;
      await db.kline.upsert({
        where: { symbol_interval_openTimeSec: { symbol: sym, interval: iv, openTimeSec: row.openTimeSec } },
        create: {
          symbol: sym,
          interval: iv,
          openTimeSec: row.openTimeSec,
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
          volume: row.volume,
          quoteVolume: row.quoteVolume,
          trades: row.trades,
        },
        update: {
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
          volume: row.volume,
          quoteVolume: row.quoteVolume,
          trades: row.trades,
        },
      });
    }
  } catch {
    // DB hiccup — the live cache still serves readers; next flush retries
  }

  // probabilistic retention prune (keep ≤ RETENTION_BARS per symbol+interval)
  if (Math.random() < 0.05) {
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      for (const iv of VALID_INTERVALS) {
        const spanSec = intervalSeconds(iv);
        await db.kline.deleteMany({
          where: { interval: iv, openTimeSec: { lt: nowSec - RETENTION_BARS * spanSec } },
        });
      }
    } catch {
      // pruning is cosmetic
    }
  }
}

export function intervalSeconds(interval: string): number {
  switch (interval) {
    case "5m":
      return 300;
    case "15m":
      return 900;
    case "1h":
      return 3_600;
    case "4h":
      return 14_400;
    case "1d":
      return 86_400;
    default:
      return 900;
  }
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/** Make sure these symbols stream over the WebSocket (and start the feed). */
export function ensureSymbols(symbols: string[]): void {
  const s = state();
  const want = new Set(symbols.filter((x) => /^[A-Z0-9]{5,15}$/.test(x)).map((x) => x.toUpperCase()));
  if (want.size === 0) return;

  for (const sym of want) {
    s.desired.add(sym.toLowerCase());
  }
  ensureTimers();
  if (s.ws && s.ws.readyState === WebSocket.OPEN) {
    subscribeDesired();
  } else {
    connect();
  }
}

/** Stop streaming a symbol (removed from the watchlist). */
export function removeSymbols(symbols: string[]): void {
  const s = state();
  for (const raw of symbols) {
    const lower = raw.trim().toLowerCase();
    if (!s.desired.delete(lower)) continue;
    if (s.ws && s.ws.readyState === WebSocket.OPEN) {
      sendSub("UNSUBSCRIBE", streamsFor(lower));
      for (const stream of streamsFor(lower)) s.streams.delete(stream);
    }
    s.prices.delete(lower.toUpperCase());
    for (const key of [...s.live.keys()]) if (key.startsWith(`${lower.toUpperCase()}|`)) s.live.delete(key);
  }
}

/** Latest spot price from the feed (null when missing/stale). */
export function getSpot(symbol: string): number | null {
  const t = state().prices.get(symbol.toUpperCase());
  if (!t || Date.now() - t.updatedAt > SPOT_FRESH_MS) return null;
  return t.lastPrice > 0 ? t.lastPrice : null;
}

/** 24h rolling stats reconstructed from the miniTicker stream (may be stale). */
export function getTicker24hFromFeed(symbol: string): Ticker24h | null {
  const t = state().prices.get(symbol.toUpperCase());
  if (!t || Date.now() - t.updatedAt > TICKER_FRESH_MS) return null;
  const change = t.lastPrice - t.openPrice;
  return {
    symbol: t.symbol,
    lastPrice: t.lastPrice,
    priceChange: change,
    priceChangePercent: t.openPrice > 0 ? (change / t.openPrice) * 100 : 0,
    highPrice: t.high,
    lowPrice: t.low,
    quoteVolume: t.quoteVolume,
  };
}

/** The newest (still open) candle the feed has seen for symbol+interval. */
export function getLiveCandle(symbol: string, interval: string): Kline | null {
  const row = state().live.get(`${symbol.toUpperCase()}|${interval}`);
  if (!row) return null;
  const span = intervalSeconds(interval) * 1000;
  return {
    openTime: row.openTimeSec * 1000,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    closeTime: row.openTimeSec * 1000 + span - 1,
    quoteVolume: row.quoteVolume,
    trades: row.trades,
  };
}

/** Feed health snapshot for the UI / engine status. */
export function feedStatus(): {
  connected: boolean;
  host: string | null;
  symbols: number;
  streams: number;
  lastMsgAt: string | null;
  reconnects: number;
  messages: number;
} {
  const s = state();
  const connected = s.ws !== null && s.ws.readyState === WebSocket.OPEN;
  return {
    connected,
    host: connected ? WS_HOSTS[s.hostIdx % WS_HOSTS.length] : null,
    symbols: s.desired.size,
    streams: s.streams.size,
    lastMsgAt: s.lastMsgAt > 0 ? new Date(s.lastMsgAt).toISOString() : null,
    reconnects: s.stats.reconnects,
    messages: s.stats.msgs,
  };
}

/** Subscribe the persisted watchlist (called on boot + engine re-arm). */
export async function ensureFeedForWatchlist(): Promise<void> {
  try {
    const rows = await db.watchItem.findMany({ select: { symbol: true } });
    const symbols = rows.map((r) => r.symbol).filter((x) => /^[A-Z0-9]{5,15}$/.test(x));
    if (symbols.length > 0) ensureSymbols(symbols);
  } catch {
    // DB not ready — routes will retry via getCandles/ensureSymbols
  }
}

/**
 * Resolve spot prices with zero REST weight whenever possible:
 * feed (≤15s fresh) → stale feed ticker → newest cached candle close.
 * REST is the last resort for symbols with no local data at all.
 */
export async function resolveSpotPrices(symbols: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const unique = [...new Set(symbols)].filter((x) => x.length > 0);
  const misses: string[] = [];

  for (const sym of unique) {
    const p = getSpot(sym);
    if (p && p > 0) out.set(sym, p);
    else misses.push(sym);
  }

  // stale-but-real feed tickers + newest cached candle closes
  const stillMissing: string[] = [];
  for (const sym of misses) {
    const t = getTicker24hFromFeed(sym);
    if (t && t.lastPrice > 0) {
      out.set(sym, t.lastPrice);
      continue;
    }
    try {
      const row = await db.kline.findFirst({
        where: { symbol: sym.toUpperCase() },
        orderBy: { openTimeSec: "desc" },
        select: { close: true },
      });
      if (row && row.close > 0) out.set(sym, row.close);
      else stillMissing.push(sym);
    } catch {
      stillMissing.push(sym);
    }
  }

  // last resort: one batched REST call for whatever is still unknown
  if (stillMissing.length > 0) {
    try {
      const { fetchTickers24h } = await import("@/lib/binance");
      const tickers = await fetchTickers24h(stillMissing);
      for (const t of tickers) if (t.lastPrice > 0) out.set(t.symbol, t.lastPrice);
    } catch {
      // banned / unreachable — cached data is the best we have
    }
  }

  return out;
}
