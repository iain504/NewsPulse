/** Shared DTO types between frontend and backend API routes. */

export type SentimentLabel = "positive" | "negative" | "neutral" | "mixed";

export interface StructuredAnalysis {
  title: string;
  sentiment: SentimentLabel;
  score: number; // -1..1
  confidence: number; // 0..1
  summary: string;
  emotions: { name: string; intensity: number }[];
  keywords: { term: string; relevance: number }[];
  entities: { name: string; type: string; impact: string }[];
  reasoning: string;
}

export interface ModelInfo {
  id: string;
  ownedBy: string;
  meta: Record<string, unknown>;
}

export interface AnalysisRow {
  id: string;
  title: string;
  source: string | null;
  sentiment: SentimentLabel;
  score: number;
  confidence: number;
  summary: string;
  emotions: string; // JSON: {name,intensity}[]
  keywords: string; // JSON: {term,relevance}[]
  entities: string | null; // JSON: {name,type,impact}[]
  model: string;
  latencyMs: number;
  createdAt: string;
}

export interface StatsResponse {
  ok: boolean;
  total: number;
  avgScore: number;
  avgConfidence: number;
  bySentiment: Record<SentimentLabel, number>;
  daily: { date: string; count: number; avgScore: number }[];
  models: { model: string; count: number; avgScore: number; avgLatencyMs: number }[];
  topKeywords: { term: string; count: number }[];
  recent: { id: string; title: string; sentiment: SentimentLabel; score: number; model: string; createdAt: string }[];
}

export interface QuizStatsResponse {
  ok: boolean;
  total: number;
  correct: number;
  accuracy: number;
  streak: number;
  bestStreak: number;
  byGuess: Record<string, { guessed: number; correct: number }>;
  history: { userGuess: string; aiSentiment: string; correct: boolean; createdAt: string }[];
}

export interface NewsItem {
  url: string;
  title: string;
  snippet: string;
  host: string;
  date: string;
  favicon: string;
}

export interface ArticleContent {
  url: string;
  title: string;
  text: string;
  publishedTime?: string;
}

export interface FollowedTopic {
  id: string;
  name: string;
  createdAt: string;
}

export type AnalyzeStreamEvent =
  | { event: "analysis"; data: { analysis: StructuredAnalysis; latencyMs: number; model: string } }
  | { event: "delta"; data: { t: string } }
  | { event: "done"; data: { id: string; createdAt: string; latencyMs: number } }
  | { event: "error"; data: { message: string } };

export const SENTIMENT_META: Record<
  SentimentLabel,
  { label: string; badge: string; dot: string; text: string; bg: string; hex: string }
> = {
  positive: {
    label: "Positive",
    badge: "bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800",
    dot: "bg-emerald-500",
    text: "text-emerald-600 dark:text-emerald-400",
    bg: "bg-emerald-500",
    hex: "#10b981",
  },
  negative: {
    label: "Negative",
    badge: "bg-rose-100 text-rose-800 border-rose-300 dark:bg-rose-950 dark:text-rose-300 dark:border-rose-800",
    dot: "bg-rose-500",
    text: "text-rose-600 dark:text-rose-400",
    bg: "bg-rose-500",
    hex: "#f43f5e",
  },
  neutral: {
    label: "Neutral",
    badge: "bg-zinc-100 text-zinc-700 border-zinc-300 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-600",
    dot: "bg-zinc-400",
    text: "text-zinc-600 dark:text-zinc-400",
    bg: "bg-zinc-400",
    hex: "#a1a1aa",
  },
  mixed: {
    label: "Mixed",
    badge: "bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800",
    dot: "bg-amber-500",
    text: "text-amber-600 dark:text-amber-400",
    bg: "bg-amber-500",
    hex: "#f59e0b",
  },
};

// ---------------------------------------------------------------------------
// Trading signals (Binance bar data → LLM entry/SL/TP)
// ---------------------------------------------------------------------------

export type SignalDirection = "BUY" | "SELL" | "WAIT";

export interface TickerRow {
  symbol: string;
  lastPrice: number;
  priceChangePercent: number;
  highPrice: number;
  lowPrice: number;
  quoteVolume: number;
}

export interface CandleRow {
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

export interface MarketSnapshot {
  symbol: string;
  interval: string;
  generatedAt: string;
  lastPrice: number;
  barCount: number;
  lastBarOpenTime: number;
  changePct24h: number;
  high24h: number;
  low24h: number;
  quoteVolume24h: number;
  ema9: number;
  ema21: number;
  ema50: number;
  rsi14: number;
  macd: { macd: number; signal: number; histogram: number };
  atr14: number;
  atrPct: number;
  bb: { upper: number; mid: number; lower: number };
  swingHigh: number;
  swingLow: number;
  volumeTrendPct: number;
  trendLabel: string;
  recentBars: { t: number; o: number; h: number; l: number; c: number; v: number }[];
}

export interface StructuredSignal {
  direction: SignalDirection;
  confidence: number;
  entry: number;
  entryLow: number;
  entryHigh: number;
  stopLoss: number;
  takeProfit: number;
  rrRatio: number;
  timeHorizon: string;
  summary: string;
  reasons: string[];
  risks: string[];
}

export interface SignalRow {
  id: string;
  symbol: string;
  interval: string;
  direction: SignalDirection;
  confidence: number;
  price: number;
  entry: number;
  entryLow: number;
  entryHigh: number;
  stopLoss: number;
  takeProfit: number;
  rrRatio: number;
  timeHorizon: string;
  summary: string;
  reasons: string[];
  risks: string[];
  rationale: string;
  model: string;
  latencyMs: number;
  source: string;
  createdAt: string;
}

export type SignalStreamEvent =
  | { event: "snapshot"; data: { snapshot: MarketSnapshot } }
  | { event: "signal"; data: { signal: StructuredSignal; latencyMs: number; model: string } }
  | { event: "delta"; data: { t: string } }
  | { event: "done"; data: { id: string; createdAt: string; latencyMs: number } }
  | { event: "error"; data: { message: string } };

export const SIGNAL_META: Record<
  SignalDirection,
  { label: string; badge: string; text: string; bg: string; hex: string }
> = {
  BUY: {
    label: "Buy / Long",
    badge: "bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800",
    text: "text-emerald-600 dark:text-emerald-400",
    bg: "bg-emerald-500",
    hex: "#10b981",
  },
  SELL: {
    label: "Sell / Short",
    badge: "bg-rose-100 text-rose-800 border-rose-300 dark:bg-rose-950 dark:text-rose-300 dark:border-rose-800",
    text: "text-rose-600 dark:text-rose-400",
    bg: "bg-rose-500",
    hex: "#f43f5e",
  },
  WAIT: {
    label: "Wait",
    badge: "bg-zinc-100 text-zinc-700 border-zinc-300 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-600",
    text: "text-zinc-600 dark:text-zinc-400",
    bg: "bg-zinc-400",
    hex: "#a1a1aa",
  },
};

export const TIMEFRAMES = ["5m", "15m", "1h", "4h", "1d"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

// ---------------------------------------------------------------------------
// Paper trading (simulated trades + P&L)
// ---------------------------------------------------------------------------

export type TradeDirection = "BUY" | "SELL";
export type TradeExitReason = "TP" | "SL" | "MANUAL";

/** Snapshot of the originating signal, embedded in every trade row. */
export interface TradeSignalDetail {
  id: string;
  direction: SignalDirection;
  /** 0..1 */
  confidence: number;
  entry: number;
  entryLow: number;
  entryHigh: number;
  stopLoss: number;
  takeProfit: number;
  rrRatio: number;
  interval: string;
  timeHorizon: string;
  summary: string;
  reasons: string[];
  risks: string[];
  /** Streamed analyst rationale ("trading plan") stored with the signal. */
  rationale: string;
  model: string;
  createdAt: string;
}

export interface TradeRow {
  id: string;
  signalId: string | null;
  symbol: string;
  direction: TradeDirection;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  quantity: number;
  notional: number;
  /** Signal confidence (0..1) snapshot at open — from the risk sizing engine. */
  confidence: number | null;
  /** Equity % that a stop-loss hit would have cost at open. */
  riskPct: number | null;
  /** USDT loss configured at open if the stop-loss is hit. */
  riskAmount: number | null;
  status: "OPEN" | "CLOSED";
  /** MANUAL = simulated by the user · AUTO = opened by the R:R + confidence engine */
  source: "MANUAL" | "AUTO";
  exitPrice: number | null;
  pnl: number | null;
  pnlPct: number | null;
  exitReason: TradeExitReason | null;
  openedAt: string;
  closedAt: string | null;
  /** The originating signal: analyst reason, levels, confidence, model… */
  signal: TradeSignalDetail | null;
}

/** OPEN trade enriched with the live market price for unrealized P&L. */
export interface OpenTradeRow extends TradeRow {
  currentPrice: number;
  unrealizedPnl: number;
  unrealizedPct: number;
  /** 0..100 — how far price has travelled from SL (0) to TP (100). */
  progressPct: number;
}

export interface TradeStats {
  startBalance: number;
  realizedPnl: number;
  unrealizedPnl: number;
  balance: number;
  openCount: number;
  closedCount: number;
  wins: number;
  losses: number;
  /** 0..100 */
  winRate: number;
  bestPnl: number;
  worstPnl: number;
  totalVolume: number;
}

export interface TradesResponse {
  ok: boolean;
  open: OpenTradeRow[];
  closed: TradeRow[];
  stats: TradeStats;
}

export interface WatchItemRow {
  id: string;
  symbol: string;
  scan: boolean;
  createdAt: string;
}

export const NOTIONAL_OPTIONS = [100, 250, 500, 1000, 5000] as const;
export const PAPER_START_BALANCE = 10_000;

export type SizingMode = "auto" | "fixed";

/** Server-computed sizing preview for the position-size control. */
export interface SizingPreview {
  confidence: number; // 0..100
  multiplier: number; // 0.5..2
  riskPct: number; // % of equity
  riskAmount: number; // USDT at risk if SL hits
  stopDistance: number;
  stopPct: number; // % from fill to SL
  notional: number; // USDT position size
  quantity: number;
  capped: boolean;
  fillPrice: number;
}

export interface SizingResponse {
  ok: boolean;
  equity: number;
  /** Present when the sizing engine could run (valid stop, live price). */
  auto: SizingPreview | null;
  /** Risk info when a fixed notional was requested. */
  fixed: SizingPreview | null;
  error?: string;
}

/** Position-size control presets shown in the signal card. */
export const SIZING_LABEL: Record<SizingMode, string> = {
  auto: "Auto · confidence",
  fixed: "Fixed USDT",
};

/** A BUY/SELL signal plotted on the candlestick chart. */
export interface ChartMarker {
  /** bar openTime (ms) the marker attaches to */
  time: number;
  direction: "BUY" | "SELL";
  price: number;
  /** iso timestamp of the originating signal */
  at: string;
}

export const RISK_PROFILES: { value: string; label: string; hint: string }[] = [
  { value: "conservative", label: "Conservative", hint: "R:R ≥ 2.0 · confluence required" },
  { value: "balanced", label: "Balanced", hint: "R:R ≥ 1.8 · standard setups" },
  { value: "aggressive", label: "Aggressive", hint: "R:R ≥ 1.5 · early reversals" },
];

export const SCAN_INTERVALS = [5, 10, 15, 30] as const; // minutes

export const DEFAULT_SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT"];

// ---- automation engine (server-side, persisted in the DB) -----------------

export interface EngineConfigState {
  armed: boolean;
  autoScan: boolean;
  autoTrade: boolean;
  minConfidence: number;
  minRR: number;
  scanMinutes: number;
  interval: string;
  riskProfile: string;
  model: string;
}

export interface EngineStatusInfo {
  config: EngineConfigState;
  running: boolean;
  nextScanAt: string | null;
  lastTickAt: string | null;
  lastTickMs: number | null;
  openTrade: { symbol: string; direction: string; openedAt: string } | null;
  /** WebSocket market feed health (live data, zero request weight) */
  feed: {
    connected: boolean;
    symbols: number;
    streams: number;
    lastMsgAt: string | null;
    reconnects: number;
  };
  /** governed Binance REST state (weight budget + IP-ban tracking) */
  rest: {
    bannedUntil: string | null;
    weightUsed: number;
    budgetPerMin: number;
  };
}

export interface EngineEventRow {
  id: string;
  type: "scan" | "signal" | "open" | "skip" | "close" | "error" | "info" | (string & {});
  symbol: string | null;
  message: string;
  createdAt: string;
}

export interface EngineResponse extends EngineStatusInfo {
  ok: boolean;
}
