/**
 * LLM trade-signal logic: market snapshot builder, prompts, and a strict
 * normalizer that guarantees SL/TP geometry is always coherent.
 * Pure module — no server-only imports.
 */

import type { Kline, Ticker24h } from "@/lib/binance";
import { atrSeries, bollingerLast, emaSeries, macdLast, rsiSeries } from "@/lib/indicators";
import { roundPrice } from "@/lib/format";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SignalDirection = "BUY" | "SELL" | "WAIT";
export type TimeHorizon = "scalp" | "intraday" | "swing";
export type RiskProfile = "conservative" | "balanced" | "aggressive";

export interface MarketSnapshot {
  symbol: string;
  interval: string;
  generatedAt: string; // ISO
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
  confidence: number; // 0..1
  entry: number;
  entryLow: number;
  entryHigh: number;
  stopLoss: number;
  takeProfit: number;
  rrRatio: number;
  timeHorizon: TimeHorizon;
  summary: string;
  reasons: string[];
  risks: string[];
}

export interface ChatMessageLocal {
  role: "system" | "user" | "assistant";
  content: string;
}

// ---------------------------------------------------------------------------
// Market snapshot
// ---------------------------------------------------------------------------

function fmtNum(n: number, digits = 2): string {
  return Number.isFinite(n) ? n.toFixed(digits) : "n/a";
}

export function buildMarketSnapshot(
  symbol: string,
  interval: string,
  klines: Kline[],
  ticker: Ticker24h | null,
): MarketSnapshot {
  const closes = klines.map((k) => k.close);
  const lastIdx = closes.length - 1;
  const lastPrice = closes[lastIdx] ?? 0;

  const ema9 = emaSeries(closes, 9)[lastIdx];
  const ema21 = emaSeries(closes, 21)[lastIdx];
  const ema50 = emaSeries(closes, 50)[lastIdx];
  const rsi = rsiSeries(closes, 14)[lastIdx];
  const macd = macdLast(closes);
  const atr = atrSeries(klines, 14)[lastIdx];
  const bb = bollingerLast(closes, 20, 2);

  const swingWindow = klines.slice(-40);
  const swingHigh = Math.max(...swingWindow.map((k) => k.high));
  const swingLow = Math.min(...swingWindow.map((k) => k.low));

  const vols = klines.map((k) => k.volume);
  const last5 = vols.slice(-5);
  const last20 = vols.slice(-20);
  const avg = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  const volAvg20 = avg(last20);
  const volumeTrendPct = volAvg20 > 0 ? ((avg(last5) - volAvg20) / volAvg20) * 100 : 0;

  // Deterministic trend label
  let trendLabel = "sideways / mixed";
  const up = ema9 > ema21 && ema21 > ema50;
  const down = ema9 < ema21 && ema21 < ema50;
  if (up) trendLabel = "bullish alignment (EMA9 > EMA21 > EMA50)";
  else if (down) trendLabel = "bearish alignment (EMA9 < EMA21 < EMA50)";
  else if (lastPrice > ema50) trendLabel = "price above EMA50 but MAs not fully aligned";
  else if (lastPrice < ema50) trendLabel = "price below EMA50, MAs not aligned";

  const barsAgo24h = Math.max(1, klines.findIndex((k) => k.openTime >= Date.now() - 86_400_000));
  const ref24h =
    ticker !== null && Number.isFinite(ticker.lastPrice) && ticker.lastPrice > 0
      ? ticker.lastPrice / (1 + ticker.priceChangePercent / 100)
      : closes[Math.max(0, closes.length - barsAgo24h)];
  const changePct24h =
    ticker && Number.isFinite(ticker.priceChangePercent)
      ? ticker.priceChangePercent
      : ref24h > 0
        ? ((lastPrice - ref24h) / ref24h) * 100
        : 0;

  return {
    symbol,
    interval,
    generatedAt: new Date().toISOString(),
    lastPrice,
    barCount: klines.length,
    lastBarOpenTime: klines[lastIdx]?.openTime ?? 0,
    changePct24h,
    high24h: ticker?.highPrice ?? Math.max(...klines.slice(-Math.min(klines.length, barsAgo24h || klines.length)).map((k) => k.high)),
    low24h: ticker?.lowPrice ?? Math.min(...klines.slice(-Math.min(klines.length, barsAgo24h || klines.length)).map((k) => k.low)),
    quoteVolume24h: ticker?.quoteVolume ?? klines[lastIdx]?.quoteVolume ?? 0,
    ema9: Number.isFinite(ema9) ? ema9 : lastPrice,
    ema21: Number.isFinite(ema21) ? ema21 : lastPrice,
    ema50: Number.isFinite(ema50) ? ema50 : lastPrice,
    rsi14: Number.isFinite(rsi) ? rsi : 50,
    macd: {
      macd: Number.isFinite(macd.macd) ? macd.macd : 0,
      signal: Number.isFinite(macd.signal) ? macd.signal : 0,
      histogram: Number.isFinite(macd.histogram) ? macd.histogram : 0,
    },
    atr14: Number.isFinite(atr) ? atr : lastPrice * 0.01,
    atrPct: lastPrice > 0 ? ((Number.isFinite(atr) ? atr : lastPrice * 0.01) / lastPrice) * 100 : 1,
    bb,
    swingHigh,
    swingLow,
    volumeTrendPct,
    trendLabel,
    recentBars: klines.slice(-24).map((k) => ({
      t: k.openTime,
      o: k.open,
      h: k.high,
      l: k.low,
      c: k.close,
      v: k.volume,
    })),
  };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export const SIGNAL_SYSTEM_PROMPT = `You are a disciplined crypto technical-analysis tutor for a study lab. You receive OHLCV bar data and pre-computed indicators for ONE trading pair and must decide whether there is a high-quality entry RIGHT NOW: LONG (BUY), SHORT (SELL), or no trade (WAIT), with precise Stop-Loss (SL) and Take-Profit (TP) levels.

Respond with ONLY one valid JSON object — no markdown fences, no commentary — matching exactly this schema:
{
  "direction": "BUY" | "SELL" | "WAIT",
  "confidence": number,        // 0..1 conviction in this setup
  "entry": number,             // ideal entry price
  "entryLow": number,          // lower bound of acceptable entry zone
  "entryHigh": number,         // upper bound of acceptable entry zone
  "stopLoss": number,          // invalidation level
  "takeProfit": number,        // primary target
  "timeHorizon": "scalp" | "intraday" | "swing",
  "summary": string,           // one sentence, max 160 chars
  "reasons": [string],         // 3-5 evidence points, each citing actual indicator values from the data
  "risks": [string]            // 2-3 invalidation triggers or caveats
}

HARD RULES (geometry is validated — violating them makes the answer useless):
- BUY: stopLoss < entryLow <= entry <= entryHigh < takeProfit.
- SELL: takeProfit < entryLow <= entry <= entryHigh < stopLoss.
- WAIT: set entry, entryLow, entryHigh, stopLoss, takeProfit all equal to the current price.
- Stops: |entry - stopLoss| >= 1.0 x ATR14. Target: |takeProfit - entry| >= 1.5 x ATR14.
- Anchor levels to real structure from the data: swing high/low, EMA clusters, Bollinger bands, round-number proximity.
- If confidence < 0.55, or trend/momentum/volume conflict, output WAIT. Patience is a position.
- Use ONLY the provided data. Never invent numbers you were not given. Output raw JSON only.`;

const RISK_PROFILE_RULES: Record<RiskProfile, string> = {
  conservative:
    "RISK PROFILE — conservative: demand strong confluence (trend + momentum + volume). Require reward:risk >= 2.0. Prefer WAIT over marginal setups.",
  balanced:
    "RISK PROFILE — balanced: standard tactical setups. Require reward:risk >= 1.8. WAIT when indicators conflict.",
  aggressive:
    "RISK PROFILE — aggressive: you may trade early reversals and breakouts with tighter stops. Require reward:risk >= 1.5. Still WAIT into clearly choppy, directionless tape.",
};

export function buildSignalUserPrompt(snap: MarketSnapshot, riskProfile: RiskProfile): string {
  const bars = snap.recentBars
    .map(
      (b) =>
        `${new Date(b.t).toISOString().slice(5, 16)} O=${roundPrice(b.o)} H=${roundPrice(b.h)} L=${roundPrice(b.l)} C=${roundPrice(b.c)} V=${b.v.toFixed(1)}`,
    )
    .join("\n");

  return `MARKET: ${snap.symbol} · Binance spot · interval ${snap.interval} · generated ${snap.generatedAt}

24H TICKER: last=${roundPrice(snap.lastPrice)} change=${snap.changePct24h.toFixed(2)}% high=${roundPrice(snap.high24h)} low=${roundPrice(snap.low24h)} quoteVol=${snap.quoteVolume24h.toFixed(0)}

INDICATORS (computed from the last ${snap.barCount} bars):
- EMA9=${roundPrice(snap.ema9)} EMA21=${roundPrice(snap.ema21)} EMA50=${roundPrice(snap.ema50)}
- Trend: ${snap.trendLabel}
- RSI14=${fmtNum(snap.rsi14, 1)}
- MACD(12,26,9): macd=${snap.macd.macd.toFixed(4)} signal=${snap.macd.signal.toFixed(4)} histogram=${snap.macd.histogram.toFixed(4)}
- ATR14=${roundPrice(snap.atr14)} (${snap.atrPct.toFixed(2)}% of price)
- Bollinger(20,2): upper=${roundPrice(snap.bb.upper)} mid=${roundPrice(snap.bb.mid)} lower=${roundPrice(snap.bb.lower)}
- 40-bar swing high=${roundPrice(snap.swingHigh)} swing low=${roundPrice(snap.swingLow)}
- Volume: last-5-bar avg vs 20-bar avg = ${snap.volumeTrendPct >= 0 ? "+" : ""}${snap.volumeTrendPct.toFixed(1)}%

RECENT BARS (oldest → newest, last 24):
${bars}

${RISK_PROFILE_RULES[riskProfile]}

Decide NOW: BUY, SELL or WAIT with entry zone, stop-loss and take-profit anchored to the data above. Remember the hard geometry rules. Output the raw JSON object only.`;
}

export function buildPlanMessages(sig: StructuredSignal, snap: MarketSnapshot): ChatMessageLocal[] {
  const verdict = {
    direction: sig.direction,
    confidence: Number(sig.confidence.toFixed(2)),
    entryZone: [roundPrice(sig.entryLow), roundPrice(sig.entryHigh)],
    stopLoss: roundPrice(sig.stopLoss),
    takeProfit: roundPrice(sig.takeProfit),
    rewardRisk: Number(sig.rrRatio.toFixed(2)),
    horizon: sig.timeHorizon,
  };
  return [
    {
      role: "system",
      content:
        "You are a patient trading-plan mentor. You explain technical verdicts in plain flowing prose. No markdown, no bullet points, no JSON, no headings — just text.",
    },
    {
      role: "user",
      content: `Market: ${snap.symbol} ${snap.interval}. Last price ${roundPrice(snap.lastPrice)}. ATR14 ${roundPrice(snap.atr14)}. RSI ${snap.rsi14.toFixed(1)}. Trend: ${snap.trendLabel}.

Structured verdict: ${JSON.stringify(verdict)}

Write a concise educational explanation (4-6 sentences):
1. Why the data leads to "${sig.direction}" with confidence ${Math.round(sig.confidence * 100)}%.
2. How the entry zone, stop-loss and take-profit relate to actual levels (swing high/low, EMAs, ATR).
3. What would invalidate this plan.
4. One caution that this is an educational exercise, not financial advice.
Plain prose only.`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Normalization — guarantees coherent SL/TP geometry
// ---------------------------------------------------------------------------

const VALID_HORIZONS: TimeHorizon[] = ["scalp", "intraday", "swing"];

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function numOr(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function cleanStr(v: unknown, maxLen: number, fallback = ""): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return fallback;
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function cleanList(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((item) => cleanStr(item, maxLen))
    .filter((s) => s.length > 0)
    .slice(0, maxItems);
}

export function normalizeSignal(raw: Record<string, unknown>, snap: MarketSnapshot): StructuredSignal {
  const px = snap.lastPrice;
  const atr = snap.atr14 > 0 ? snap.atr14 : px * 0.01;

  const dirRaw = cleanStr(raw.direction, 10).toUpperCase();
  let direction: SignalDirection = dirRaw === "BUY" || dirRaw === "SELL" ? dirRaw : "WAIT";
  let confidence = clampNum(raw.confidence, 0, 1, 0.5);

  let entry = numOr(raw.entry, px);
  let entryLow = numOr(raw.entryLow, entry * 0.999);
  let entryHigh = numOr(raw.entryHigh, entry * 1.001);
  let stopLoss = numOr(raw.stopLoss, direction === "SELL" ? entry + 1.5 * atr : entry - 1.5 * atr);
  let takeProfit = numOr(raw.takeProfit, direction === "SELL" ? entry - 2.5 * atr : entry + 2.5 * atr);

  let rrRatio: number;

  if (direction === "WAIT" || confidence < 0.55) {
    direction = "WAIT";
    confidence = Math.min(confidence, 0.5);
    entry = px;
    entryLow = px - 0.25 * atr;
    entryHigh = px + 0.25 * atr;
    stopLoss = px - 1.5 * atr;
    takeProfit = px + 1.5 * atr;
    rrRatio = 0;
  } else if (direction === "BUY") {
    if (entryLow > entryHigh) [entryLow, entryHigh] = [entryHigh, entryLow];
    entryLow = Math.max(0, entryLow);
    if (entry < entryLow || entry > entryHigh) entry = (entryLow + entryHigh) / 2;
    stopLoss = Math.min(stopLoss, entryLow - 0.6 * atr); // strictly below the zone
    takeProfit = Math.max(takeProfit, entryHigh + 0.9 * atr); // strictly above the zone
    const risk = entry - stopLoss;
    rrRatio = risk > 0 ? (takeProfit - entry) / risk : 0;
  } else {
    if (entryLow > entryHigh) [entryLow, entryHigh] = [entryHigh, entryLow];
    if (entry < entryLow || entry > entryHigh) entry = (entryLow + entryHigh) / 2;
    stopLoss = Math.max(stopLoss, entryHigh + 0.6 * atr);
    takeProfit = Math.min(takeProfit, entryLow - 0.9 * atr);
    const risk = stopLoss - entry;
    rrRatio = risk > 0 ? (entry - takeProfit) / risk : 0;
  }

  const horizonRaw = cleanStr(raw.timeHorizon, 12).toLowerCase() as TimeHorizon;
  const timeHorizon = VALID_HORIZONS.includes(horizonRaw) ? horizonRaw : "intraday";

  return {
    direction,
    confidence,
    entry: roundPrice(entry),
    entryLow: roundPrice(Math.min(entryLow, entryHigh)),
    entryHigh: roundPrice(Math.max(entryLow, entryHigh)),
    stopLoss: roundPrice(stopLoss),
    takeProfit: roundPrice(takeProfit),
    rrRatio: Math.round(rrRatio * 100) / 100,
    timeHorizon,
    summary: cleanStr(raw.summary, 200, `${direction} setup on ${snap.symbol} ${snap.interval}.`),
    reasons: cleanList(raw.reasons, 5, 240),
    risks: cleanList(raw.risks, 4, 240),
  };
}
