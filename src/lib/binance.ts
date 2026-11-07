/**
 * Binance public market-data client (server-side only).
 *
 * Uses Binance's free, unauthenticated market-data endpoints. The official
 * public data host (data-api.binance.vision) is tried first with
 * api.binance.com hosts as fallbacks.
 */

const HOSTS = [
  "https://data-api.binance.vision",
  "https://api.binance.com",
  "https://api1.binance.com",
  "https://api2.binance.com",
];

export const VALID_INTERVALS = ["5m", "15m", "1h", "4h", "1d"] as const;
export type BinanceInterval = (typeof VALID_INTERVALS)[number];

export function isBinanceInterval(v: string): v is BinanceInterval {
  return (VALID_INTERVALS as readonly string[]).includes(v);
}

export function isValidSymbol(v: string): boolean {
  return /^[A-Z0-9]{5,15}$/.test(v);
}

export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  quoteVolume: number;
  trades: number;
}

export interface Ticker24h {
  symbol: string;
  lastPrice: number;
  priceChange: number;
  priceChangePercent: number;
  highPrice: number;
  lowPrice: number;
  quoteVolume: number;
}

async function binanceGet<T>(path: string, timeoutMs = 12_000): Promise<T> {
  let lastErr: unknown = null;
  for (const host of HOSTS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${host}${path}`, {
        signal: ctrl.signal,
        cache: "no-store",
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        // 4xx from Binance (e.g. invalid symbol) — no point trying other hosts
        if (res.status >= 400 && res.status < 500) {
          let msg = `Binance rejected the request (${res.status})`;
          try {
            const j = JSON.parse(text) as { msg?: string };
            if (j?.msg) msg = `Binance: ${j.msg}`;
          } catch {
            // keep default message
          }
          throw new ClientError(msg);
        }
        throw new Error(`Binance ${res.status}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof ClientError) throw err;
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(
    `Binance is unreachable: ${lastErr instanceof Error ? lastErr.message : "unknown error"}`,
  );
}

export class ClientError extends Error {}

type RawKline = [number, string, string, string, string, string, number, string, number, ...unknown[]];

/** Fetch recent OHLCV bars. limit: 60..500 */
export async function fetchKlines(
  symbol: string,
  interval: BinanceInterval,
  limit = 150,
): Promise<Kline[]> {
  const clamped = Math.min(500, Math.max(60, Math.floor(limit)));
  const raw = await binanceGet<RawKline[]>(
    `/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${clamped}`,
  );
  if (!Array.isArray(raw)) throw new Error("Unexpected klines payload");
  return raw.map((k) => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    closeTime: k[6],
    quoteVolume: parseFloat(k[7]),
    trades: k[8],
  }));
}

type RawTicker = {
  symbol: string;
  lastPrice: string;
  priceChange: string;
  priceChangePercent: string;
  highPrice: string;
  lowPrice: string;
  quoteVolume: string;
};

function normalizeTicker(t: RawTicker): Ticker24h {
  return {
    symbol: t.symbol,
    lastPrice: parseFloat(t.lastPrice),
    priceChange: parseFloat(t.priceChange),
    priceChangePercent: parseFloat(t.priceChangePercent),
    highPrice: parseFloat(t.highPrice),
    lowPrice: parseFloat(t.lowPrice),
    quoteVolume: parseFloat(t.quoteVolume),
  };
}

/** 24h rolling stats for one symbol. */
export async function fetchTicker24h(symbol: string): Promise<Ticker24h> {
  const raw = await binanceGet<RawTicker>(`/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`);
  return normalizeTicker(raw);
}

/** Batch 24h stats (Binance accepts a JSON array in `symbols`). */
export async function fetchTickers24h(symbols: string[]): Promise<Ticker24h[]> {
  const valid = symbols.filter(isValidSymbol).slice(0, 12);
  if (valid.length === 0) return [];
  const param = encodeURIComponent(JSON.stringify(valid));
  const raw = await binanceGet<RawTicker[]>(`/api/v3/ticker/24hr?symbols=${param}`);
  return (Array.isArray(raw) ? raw : []).map(normalizeTicker);
}
