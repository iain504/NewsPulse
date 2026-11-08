/**
 * Binance public market-data REST client (server-side only) — behind a strict
 * request-weight governor.
 *
 * Binance bans IPs that exceed the per-minute request weight (HTTP 418 with
 * "Way too much request weight used; IP banned until …"). This app used to
 * poll klines/tickers on every UI refresh and engine cycle, which triggered
 * exactly that ban. The governor below makes that impossible again:
 *
 *  - a hard global budget of REST weight per minute (default 40 — the real
 *    limit is 6,000) shared across all hosts;
 *  - per-host ban tracking: HTTP 418/429 responses parse the "IP banned
 *    until <ms>" payload (or Retry-After header) and the host is blacklisted
 *    until then;
 *  - automatic failover across Binance's public hosts while any of them is
 *    still reachable.
 *
 * Routine market data flows through the WebSocket feed + local candle cache
 * instead (see market-feed.ts / candle-store.ts); REST is only a last-resort
 * bootstrap/fallback.
 */

const HOST_ORIGINS = [
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

export class ClientError extends Error {}

/** Thrown when every Binance host refuses our IP (418/429 weight ban). */
export class BinanceBanError extends Error {
  readonly banUntil: number | null;
  constructor(message: string, banUntil: number | null = null) {
    super(message);
    this.banUntil = banUntil;
  }
}

/** Thrown when the local weight budget is exhausted for the current minute. */
export class BinanceBudgetError extends Error {}

// ---------------------------------------------------------------------------
// request-weight governor (global — the ban is per IP, not per host)
// ---------------------------------------------------------------------------

interface HostState {
  origin: string;
  /** epoch ms until which this host refused our IP (0 = healthy) */
  banUntil: number;
}

const hostStates: HostState[] = HOST_ORIGINS.map((origin) => ({ origin, banUntil: 0 }));

/** Hard REST weight budget per minute — a fraction of Binance's 6,000 limit. */
export const REST_WEIGHT_BUDGET_PER_MIN = 40;

const governor = {
  windowStart: Math.floor(Date.now() / 60_000),
  used: 0,
};

function rollWindowIfNeeded(): void {
  const nowWindow = Math.floor(Date.now() / 60_000);
  if (nowWindow !== governor.windowStart) {
    governor.windowStart = nowWindow;
    governor.used = 0;
  }
}

/** Epoch ms of the earliest unbanned host (null = all healthy / none banned). */
export function restBanUntil(): number | null {
  const bans = hostStates.filter((h) => h.banUntil > Date.now()).map((h) => h.banUntil);
  return bans.length > 0 ? Math.max(...bans) : null;
}

/** Snapshot of the REST governor for the UI / engine status. */
export function binanceRestStatus(): {
  budgetPerMin: number;
  usedThisMin: number;
  bannedUntil: number | null;
  hosts: { origin: string; bannedUntil: number }[];
} {
  rollWindowIfNeeded();
  return {
    budgetPerMin: REST_WEIGHT_BUDGET_PER_MIN,
    usedThisMin: governor.used,
    bannedUntil: restBanUntil(),
    hosts: hostStates.map((h) => ({ origin: h.origin, bannedUntil: h.banUntil })),
  };
}

/** Parse "IP banned until 1794139545096" (or a Retry-After fallback). */
function extractBanMs(msg: string, retryAfterHeader: string | null): number | null {
  const m = /banned until (\d{10,13})/i.exec(msg);
  if (m) {
    const v = Number(m[1]);
    if (Number.isFinite(v)) return v < 1e12 ? v * 1000 : v; // seconds → ms
  }
  const ra = Number(retryAfterHeader);
  if (Number.isFinite(ra) && ra > 0) return Date.now() + ra * 1000;
  return null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface GovernorOptions {
  /** weight this call will consume (klines=2, ticker=2…) */
  weight: number;
  /** wait up to this long for budget to free up (0 = fail fast) */
  maxWaitMs?: number;
}

async function acquireBudget(opts: GovernorOptions): Promise<void> {
  const { weight, maxWaitMs = 4_000 } = opts;
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    rollWindowIfNeeded();
    if (governor.used + weight <= REST_WEIGHT_BUDGET_PER_MIN) {
      governor.used += weight;
      return;
    }
    if (Date.now() >= deadline) {
      throw new BinanceBudgetError(
        "Binance REST budget for this minute is used up — cached/WS data will fill in shortly.",
      );
    }
    await sleep(Math.min(1_000, deadline - Date.now()));
  }
}

async function binanceGet<T>(path: string, weight = 2, timeoutMs = 12_000): Promise<T> {
  let lastErr: unknown = null;
  let allBanned = true;

  for (const host of hostStates) {
    if (host.banUntil > Date.now()) continue; // host currently refusing our IP
    allBanned = false;

    try {
      await acquireBudget({ weight });
    } catch (err) {
      if (err instanceof BinanceBudgetError) throw err;
      throw err;
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${host.origin}${path}`, {
        signal: ctrl.signal,
        cache: "no-store",
      });

      // weight bookkeeping from the response header
      const usedHeader = Number(res.headers.get("x-mbx-used-weight-1m"));
      if (Number.isFinite(usedHeader) && usedHeader > governor.used) {
        governor.used = Math.min(usedHeader, REST_WEIGHT_BUDGET_PER_MIN);
      }

      if (res.status === 418 || res.status === 429) {
        const text = await res.text().catch(() => "");
        const banMs = extractBanMs(text, res.headers.get("retry-after"));
        host.banUntil = banMs ?? Date.now() + 60_000;
        lastErr = new BinanceBanError(
          `Binance refused this IP (${res.status})${banMs ? ` until ${new Date(banMs).toLocaleTimeString()}` : ""} — switch to the WebSocket feed.`,
          banMs,
        );
        continue; // try the next host
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        // hard 4xx (e.g. invalid symbol) — other hosts behave the same
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
      if (err instanceof ClientError || err instanceof BinanceBudgetError) throw err;
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }

  if (allBanned || hostStates.every((h) => h.banUntil > Date.now())) {
    const until = restBanUntil();
    throw new BinanceBanError(
      `Binance REST is IP-banned${until ? ` until ${new Date(until).toLocaleTimeString()}` : ""} — the WebSocket feed keeps data live meanwhile.`,
      until,
    );
  }
  throw new Error(
    `Binance is unreachable: ${lastErr instanceof Error ? lastErr.message : "unknown error"}`,
  );
}

type RawKline = [number, string, string, string, string, string, number, string, number, ...unknown[]];

/** Fetch recent OHLCV bars (bootstrap only — routine reads use the cache). limit: 60..500 */
export async function fetchKlines(
  symbol: string,
  interval: BinanceInterval,
  limit = 150,
): Promise<Kline[]> {
  const clamped = Math.min(500, Math.max(60, Math.floor(limit)));
  const raw = await binanceGet<RawKline[]>(
    `/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${clamped}`,
    2,
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

/** 24h rolling stats for one symbol (fallback path — feed preferred). */
export async function fetchTicker24h(symbol: string): Promise<Ticker24h> {
  const raw = await binanceGet<RawTicker>(`/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`, 2);
  return normalizeTicker(raw);
}

/** Batch 24h stats (Binance accepts a JSON array in `symbols`). */
export async function fetchTickers24h(symbols: string[]): Promise<Ticker24h[]> {
  const valid = symbols.filter(isValidSymbol).slice(0, 12);
  if (valid.length === 0) return [];
  const param = encodeURIComponent(JSON.stringify(valid));
  const raw = await binanceGet<RawTicker[]>(`/api/v3/ticker/24hr?symbols=${param}`, 2);
  return (Array.isArray(raw) ? raw : []).map(normalizeTicker);
}
