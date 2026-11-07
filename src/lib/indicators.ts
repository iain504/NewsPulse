/**
 * Deterministic technical indicators computed server-side from Binance klines.
 * These feed both the LLM prompt and the UI so every signal is grounded in
 * reproducible math, not hallucinated numbers.
 */

import type { Kline } from "@/lib/binance";

/** Exponential moving average series (seeded with SMA of the first window). */
export function emaSeries(values: number[], period: number): number[] {
  const out: number[] = [];
  if (values.length < period) return values.map(() => NaN);
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  for (let i = 0; i < period - 1; i++) out.push(NaN);
  out.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function last(series: number[]): number {
  return series.length ? series[series.length - 1] : NaN;
}

/** Wilder's RSI series. */
export function rsiSeries(closes: number[], period = 14): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/** MACD (12, 26, 9): returns the last macd / signal / histogram values. */
export function macdLast(closes: number[]): { macd: number; signal: number; histogram: number } {
  const fast = emaSeries(closes, 12);
  const slow = emaSeries(closes, 26);
  const macdLine = closes.map((_, i) => fast[i] - slow[i]).filter((v) => !Number.isNaN(v));
  if (macdLine.length < 9) return { macd: NaN, signal: NaN, histogram: NaN };
  const signalLine = emaSeries(macdLine, 9);
  const m = last(macdLine);
  const s = last(signalLine);
  return { macd: m, signal: s, histogram: m - s };
}

/** Wilder's ATR series. */
export function atrSeries(klines: Kline[], period = 14): number[] {
  const trs: number[] = [];
  for (let i = 0; i < klines.length; i++) {
    if (i === 0) {
      trs.push(klines[i].high - klines[i].low);
      continue;
    }
    const prevClose = klines[i - 1].close;
    trs.push(
      Math.max(
        klines[i].high - klines[i].low,
        Math.abs(klines[i].high - prevClose),
        Math.abs(klines[i].low - prevClose),
      ),
    );
  }
  const out: number[] = new Array(klines.length).fill(NaN);
  if (klines.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += trs[i];
  let atr = sum / period;
  out[period - 1] = atr;
  for (let i = period; i < klines.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    out[i] = atr;
  }
  return out;
}

/** Bollinger bands (last values). */
export function bollingerLast(
  closes: number[],
  period = 20,
  mult = 2,
): { upper: number; mid: number; lower: number } {
  const slice = closes.slice(-period);
  if (slice.length < period) {
    const p = last(closes);
    return { upper: p, mid: p, lower: p };
  }
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mid) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return { upper: mid + mult * sd, mid, lower: mid - mult * sd };
}
