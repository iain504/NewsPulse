/**
 * Confidence-driven risk position sizing.
 *
 * The position is always sized so that a stop-loss hit loses a fixed budget of
 * equity ("riskAmount"), and that budget scales with the model's confidence:
 *
 *   mult      = 0.5x … 2.0x  (linear from the confidence threshold to 100%)
 *   riskPct   = BASE_RISK_PCT × mult            (percent of account equity)
 *   riskAmount= equity × riskPct / 100          (USDT loss if SL is hit)
 *   notional  = riskAmount / stopPct            (position size that risks exactly that)
 *   quantity  = notional / fillPrice
 *
 * The notional is capped at equity × MAX_LEVERAGE so a tight stop cannot
 * produce an absurd position.
 */

import { PAPER_START_BALANCE } from "@/lib/types";

/** Percent of equity risked when confidence sits exactly at the threshold (×0.5). */
export const BASE_RISK_PCT = 1.0;
/** Risk multiplier at 100% confidence. */
export const MAX_RISK_MULT = 2.0;
/** Risk multiplier when confidence equals the minimum threshold. */
export const MIN_RISK_MULT = 0.5;
/** Position size cap, expressed as equity multiple. */
export const MAX_LEVERAGE = 5;
/** Hard floor for position size (matches the API validation). */
export const MIN_NOTIONAL = 10;

export interface SizingInput {
  /** Account equity used for the risk budget (start balance + realized P&L). */
  equity: number;
  /** Price the trade is expected to fill at (live market price). */
  fillPrice: number;
  /** Stop-loss level from the signal. */
  stopLoss: number;
  /** Signal confidence, 0..1. */
  confidence: number;
  /** Auto-trade confidence threshold (0..1) — the floor of the scaling curve. */
  minConfidence: number;
}

export interface SizingResult {
  /** Confidence the sizing was computed for (0..1). */
  confidence: number;
  /** 0.5 … 2 risk multiplier. */
  multiplier: number;
  /** Percent of equity risked if the stop-loss is hit. */
  riskPct: number;
  /** USDT loss if the stop-loss is hit. */
  riskAmount: number;
  /** |fill − SL| distance in price units. */
  stopDistance: number;
  /** Stop distance as a percent of the fill price. */
  stopPct: number;
  /** USDT position size. */
  notional: number;
  /** Units of the base asset. */
  quantity: number;
  /** True when the leverage cap reduced the computed size. */
  capped: boolean;
}

export function roundQty(q: number): number {
  return Math.max(0, Math.round(q * 1e6) / 1e6);
}

/** Linear risk multiplier from the confidence threshold (×0.5) to 100% (×2). */
export function confidenceMultiplier(confidence01: number, minConfidence01: number): number {
  const span = Math.max(1e-6, 1 - minConfidence01);
  const t = Math.min(1, Math.max(0, (confidence01 - minConfidence01) / span));
  return MIN_RISK_MULT + (MAX_RISK_MULT - MIN_RISK_MULT) * t;
}

/**
 * Compute the confidence-scaled position size.
 * Returns null when sizing is impossible (bad price/stop, no risk budget).
 */
export function computeSizing(input: SizingInput): SizingResult | null {
  const { equity, fillPrice, stopLoss, confidence, minConfidence } = input;
  if (!(equity > 0) || !(fillPrice > 0)) return null;

  const stopDistance = Math.abs(fillPrice - stopLoss);
  if (!(stopDistance > 0)) return null;

  const stopPct = stopDistance / fillPrice;
  const multiplier = confidenceMultiplier(confidence, minConfidence);
  const riskPct = BASE_RISK_PCT * multiplier;
  const riskAmount = (equity * riskPct) / 100;

  let notional = riskAmount / stopPct;
  let capped = false;
  const cap = equity * MAX_LEVERAGE;
  if (notional > cap) {
    notional = cap;
    capped = true;
  }
  if (!Number.isFinite(notional) || notional < MIN_NOTIONAL) {
    notional = MIN_NOTIONAL;
    capped = true;
  }

  return {
    confidence,
    multiplier,
    riskPct,
    riskAmount: notional * stopPct,
    stopDistance,
    stopPct: stopPct * 100,
    notional,
    quantity: roundQty(notional / fillPrice),
    capped,
  };
}

/** Convenience: paper account equity before a new trade (start + realized P&L). */
export function startBalance(): number {
  return PAPER_START_BALANCE;
}
