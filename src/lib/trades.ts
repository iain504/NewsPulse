/**
 * Server-side paper-trading engine.
 *
 * Trades fill at the live Binance spot price and are evaluated on every read:
 * when the market price touches a position's stop-loss or take-profit the
 * position is closed and P&L is crystallised into the database.
 */

import { db } from "@/lib/db";
import { fetchTicker24h, fetchTickers24h, ClientError } from "@/lib/binance";
import { computeSizing, roundQty } from "@/lib/sizing";
import { roundPrice } from "@/lib/format";
import { logEngineEvent } from "@/lib/engine-events";
import {
  PAPER_START_BALANCE,
  type OpenTradeRow,
  type TradeRow,
  type TradeSignalDetail,
  type TradeStats,
  type TradesResponse,
  type TradeExitReason,
} from "@/lib/types";
import type { Signal, Trade } from "@prisma/client";

export function calcPnl(
  direction: string,
  entryPrice: number,
  exitPrice: number,
  quantity: number,
  notional: number,
): { pnl: number; pnlPct: number } {
  const pnl =
    direction === "BUY"
      ? (exitPrice - entryPrice) * quantity
      : (entryPrice - exitPrice) * quantity;
  const pnlPct = notional > 0 ? (pnl / notional) * 100 : 0;
  return { pnl, pnlPct };
}

/** 0..100 — how far the price has travelled from stop-loss (0) to take-profit (100). */
export function levelProgress(direction: string, stopLoss: number, takeProfit: number, price: number): number {
  const span = Math.abs(takeProfit - stopLoss);
  if (span <= 0) return 0;
  const done = direction === "BUY" ? price - stopLoss : stopLoss - price;
  return Math.max(0, Math.min(100, (done / span) * 100));
}

export function toOpenTradeRow(
  t: Trade & { signal: Signal | null },
  currentPrice: number,
): OpenTradeRow {
  const { pnl, pnlPct } = calcPnl(t.direction, t.entryPrice, currentPrice, t.quantity, t.notional);
  return {
    ...toTradeRow(t),
    currentPrice,
    unrealizedPnl: pnl,
    unrealizedPct: pnlPct,
    progressPct: levelProgress(t.direction, t.stopLoss, t.takeProfit, currentPrice),
  };
}

/** Parse a persisted Signal row into the embeddable analyst-detail snapshot. */
export function toSignalDetail(s: Signal): TradeSignalDetail {
  const parseList = (raw: string): string[] => {
    try {
      const arr = JSON.parse(raw) as unknown;
      return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  };
  return {
    id: s.id,
    direction: s.direction === "SELL" ? "SELL" : s.direction === "BUY" ? "BUY" : "WAIT",
    confidence: s.confidence,
    entry: s.entry,
    entryLow: s.entryLow,
    entryHigh: s.entryHigh,
    stopLoss: s.stopLoss,
    takeProfit: s.takeProfit,
    rrRatio: s.rrRatio,
    interval: s.interval,
    timeHorizon: s.timeHorizon,
    summary: s.summary,
    reasons: parseList(s.reasons),
    risks: parseList(s.risks),
    rationale: s.rationale,
    model: s.model,
    createdAt: s.createdAt.toISOString(),
  };
}

export function toTradeRow(t: Trade & { signal: Signal | null }): TradeRow {
  return {
    id: t.id,
    signalId: t.signalId,
    symbol: t.symbol,
    direction: t.direction === "SELL" ? "SELL" : "BUY",
    entryPrice: t.entryPrice,
    stopLoss: t.stopLoss,
    takeProfit: t.takeProfit,
    quantity: t.quantity,
    notional: t.notional,
    confidence: t.confidence,
    riskPct: t.riskPct,
    riskAmount: t.riskAmount,
    status: t.status === "CLOSED" ? "CLOSED" : "OPEN",
    source: t.source === "AUTO" ? "AUTO" : "MANUAL",
    exitPrice: t.exitPrice,
    pnl: t.pnl,
    pnlPct: t.pnlPct,
    exitReason: (t.exitReason as TradeExitReason | null) ?? null,
    openedAt: t.openedAt.toISOString(),
    closedAt: t.closedAt ? t.closedAt.toISOString() : null,
    signal: t.signal ? toSignalDetail(t.signal) : null,
  };
}

/** Batched last-price lookup with chunking (Binance accepts ≤12 symbols per call). */
export async function fetchPriceMap(symbols: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const unique = [...new Set(symbols)].filter((s) => s.length > 0);
  for (let i = 0; i < unique.length; i += 12) {
    const chunk = unique.slice(i, i + 12);
    try {
      const tickers = await fetchTickers24h(chunk);
      for (const t of tickers) if (t.lastPrice > 0) map.set(t.symbol, t.lastPrice);
    } catch {
      // chunk unavailable — skip; callers fall back to entry price
    }
  }
  return map;
}

/**
 * Account equity available for risk sizing: start balance + realized P&L,
 * minus unrealized drawdown on open positions (they still hold margin).
 */
export async function accountEquity(): Promise<number> {
  const rows = await db.trade.findMany({ where: { status: "OPEN" }, include: { signal: true } });
  let unrealized = 0;
  if (rows.length > 0) {
    const priceMap = await fetchPriceMap(rows.map((t) => t.symbol));
    for (const t of rows) {
      const price = priceMap.get(t.symbol);
      if (price && price > 0) {
        unrealized += calcPnl(t.direction, t.entryPrice, price, t.quantity, t.notional).pnl;
      }
    }
  }
  const agg = await db.trade.aggregate({
    where: { status: "CLOSED" },
    _sum: { pnl: true },
  });
  const realized = agg._sum.pnl ?? 0;
  const equity = PAPER_START_BALANCE + realized + unrealized;
  return equity > 0 ? equity : PAPER_START_BALANCE;
}

/**
 * Evaluate all OPEN trades against the live market price.
 * A position whose price touched its stop-loss or take-profit is closed and
 * its P&L stored. If both levels sit inside the last move, the stop-loss is
 * assumed first (conservative fill).
 *
 * Returns the trades closed by this call (so the engine can log them) and
 * writes an EngineEvent "close" line for each — closures are therefore
 * recorded no matter who triggered the evaluation.
 */
export async function evaluateOpenTrades(): Promise<(Trade & { signal: Signal | null })[]> {
  const open = await db.trade.findMany({ where: { status: "OPEN" }, include: { signal: true } });
  if (open.length === 0) return [];

  const priceMap = await fetchPriceMap(open.map((t) => t.symbol));
  const closed: (Trade & { signal: Signal | null })[] = [];

  for (const t of open) {
    const price = priceMap.get(t.symbol);
    if (!price || price <= 0) continue;
    const isBuy = t.direction === "BUY";
    const hitSL = isBuy ? price <= t.stopLoss : price >= t.stopLoss;
    const hitTP = isBuy ? price >= t.takeProfit : price <= t.takeProfit;
    if (!hitSL && !hitTP) continue;

    const exitPrice = hitSL ? t.stopLoss : t.takeProfit;
    const exitReason: TradeExitReason = hitSL ? "SL" : "TP";
    const { pnl, pnlPct } = calcPnl(t.direction, t.entryPrice, exitPrice, t.quantity, t.notional);

    const updated = await db.trade.update({
      where: { id: t.id },
      data: {
        status: "CLOSED",
        exitPrice,
        pnl,
        pnlPct,
        exitReason,
        closedAt: new Date(),
      },
    });
    closed.push({ ...updated, signal: t.signal });

    const pnlTxt = `${pnl >= 0 ? "+" : "-"}${Math.abs(pnl).toFixed(2)} USDT (${pnlPct >= 0 ? "+" : "-"}${Math.abs(pnlPct).toFixed(2)}%)`;
    await logEngineEvent({
      type: "close",
      symbol: t.symbol,
      message: `${t.symbol} ${t.direction === "BUY" ? "long" : "short"} closed — ${exitReason} hit @ ${exitPrice.toPrecision(6)} · ${pnlTxt}`,
    });
  }

  return closed;
}

// ---------------------------------------------------------------------------
// Shared trade-opening pipeline (used by POST /api/trades AND the background
// automation engine, so both enforce exactly the same rules).
// ---------------------------------------------------------------------------

export interface OpenTradeParams {
  signalId: string;
  autoSize: boolean;
  notional?: number | null;
  /** Floor of the confidence → risk sizing curve, 0..1. */
  minConfidence: number;
  source: "AUTO" | "MANUAL";
}

export type OpenTradeResult =
  | {
      ok: true;
      trade: Trade & { signal: Signal | null };
      riskPct: number | null;
      riskAmount: number | null;
    }
  | { ok: false; status: number; error: string };

/**
 * Open a simulated paper trade from a saved signal, filling at the live
 * Binance spot price. Enforces: signal exists & is actionable, SL/TP sanity,
 * single-position mode (one trade at a time), live-price guards, and the
 * confidence-driven sizing engine. Returns a typed error instead of throwing.
 */
export async function openTradeFromSignal(params: OpenTradeParams): Promise<OpenTradeResult> {
  const { signalId, autoSize, minConfidence, source } = params;

  const signal = await db.signal.findUnique({ where: { id: signalId } });
  if (!signal) {
    return { ok: false, status: 404, error: "Signal not found — it may have been deleted." };
  }
  if (signal.direction !== "BUY" && signal.direction !== "SELL") {
    return { ok: false, status: 400, error: "This signal is a WAIT — there is no trade to simulate." };
  }
  if (!(signal.stopLoss > 0) || !(signal.takeProfit > 0)) {
    return { ok: false, status: 400, error: "Signal is missing stop-loss / take-profit levels." };
  }
  const isBuy = signal.direction === "BUY";
  if (isBuy ? signal.stopLoss >= signal.takeProfit : signal.stopLoss <= signal.takeProfit) {
    return { ok: false, status: 400, error: "Signal has inverted SL/TP levels — analyze again." };
  }

  // Single-position mode — one trade at a time (long OR short, any symbol).
  const existing = await db.trade.findFirst({ where: { status: "OPEN" } });
  if (existing) {
    return {
      ok: false,
      status: 409,
      error: `Single-position mode — ${existing.symbol} ${existing.direction === "BUY" ? "long" : "short"} is still open. Close it before opening another trade.`,
    };
  }

  let price: number;
  try {
    price = (await fetchTicker24h(signal.symbol)).lastPrice;
  } catch (err) {
    const msg = err instanceof ClientError ? err.message : "Live price unavailable — try again.";
    return { ok: false, status: 502, error: msg };
  }
  if (!(price > 0)) {
    return { ok: false, status: 502, error: "Live price unavailable — try again." };
  }

  // Guard against fills that would instantly resolve the position.
  const pastStop = isBuy ? price <= signal.stopLoss : price >= signal.stopLoss;
  const pastTarget = isBuy ? price >= signal.takeProfit : price <= signal.takeProfit;
  if (pastStop) {
    return {
      ok: false,
      status: 400,
      error: `Market has moved past this signal's stop-loss (${roundPrice(signal.stopLoss)}) — analyze again for a fresh setup.`,
    };
  }
  if (pastTarget) {
    return {
      ok: false,
      status: 400,
      error: `Market is already beyond this signal's take-profit (${roundPrice(signal.takeProfit)}) — analyze again.`,
    };
  }

  // ---- position sizing ---------------------------------------------------
  const equity = await accountEquity();
  let riskPct: number | null = null;
  let riskAmount: number | null = null;
  let positionSize: number;

  if (autoSize) {
    const sizing = computeSizing({
      equity,
      fillPrice: price,
      stopLoss: signal.stopLoss,
      confidence: signal.confidence,
      minConfidence,
    });
    if (!sizing) {
      return {
        ok: false,
        status: 400,
        error: "Could not size this trade — stop-loss too close to the live price.",
      };
    }
    positionSize = sizing.notional;
  } else {
    const notional = params.notional;
    if (!Number.isFinite(notional as number) || (notional as number) < 10 || (notional as number) > 1_000_000) {
      return { ok: false, status: 400, error: "Position size must be between 10 and 1,000,000 USDT." };
    }
    positionSize = notional as number;
  }

  const quantity = Math.max(1e-8, roundQty(positionSize / price));

  // Risk snapshot for every trade (fixed mode too) so history can display it.
  const stopDistance = Math.abs(price - signal.stopLoss);
  riskAmount = quantity * stopDistance;
  riskPct = equity > 0 ? (riskAmount / equity) * 100 : null;

  const trade = await db.trade.create({
    data: {
      signal: { connect: { id: signal.id } },
      symbol: signal.symbol,
      direction: signal.direction,
      entryPrice: price,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      quantity,
      notional: positionSize,
      confidence: signal.confidence,
      riskPct,
      riskAmount,
      source,
    },
  });

  const enriched = await db.trade.findUnique({
    where: { id: trade.id },
    include: { signal: true },
  });
  if (!enriched) {
    return { ok: false, status: 500, error: "Trade vanished right after creation." };
  }

  return { ok: true, trade: enriched, riskPct, riskAmount };
}

/** Evaluate, then assemble the full account snapshot for the UI. */
export async function buildTradesResponse(): Promise<TradesResponse> {
  await evaluateOpenTrades();

  const rows = await db.trade.findMany({ orderBy: [{ openedAt: "desc" }], include: { signal: true } });
  const openRows = rows.filter((r) => r.status === "OPEN");
  const closedRows = rows.filter((r) => r.status === "CLOSED");

  const priceMap = await fetchPriceMap(openRows.map((t) => t.symbol));

  const open = openRows.map((t) => {
    const price = priceMap.get(t.symbol);
    return toOpenTradeRow(t, price && price > 0 ? price : t.entryPrice);
  });

  const realizedPnl = closedRows.reduce((acc, t) => acc + (t.pnl ?? 0), 0);
  const unrealizedPnl = open.reduce((acc, t) => acc + t.unrealizedPnl, 0);
  const wins = closedRows.filter((t) => (t.pnl ?? 0) > 0).length;
  const losses = closedRows.filter((t) => (t.pnl ?? 0) < 0).length;
  const pnls = closedRows.map((t) => t.pnl ?? 0);

  const stats: TradeStats = {
    startBalance: PAPER_START_BALANCE,
    realizedPnl,
    unrealizedPnl,
    balance: PAPER_START_BALANCE + realizedPnl + unrealizedPnl,
    openCount: open.length,
    closedCount: closedRows.length,
    wins,
    losses,
    winRate: closedRows.length > 0 ? (wins / closedRows.length) * 100 : 0,
    bestPnl: pnls.length > 0 ? Math.max(...pnls) : 0,
    worstPnl: pnls.length > 0 ? Math.min(...pnls) : 0,
    totalVolume: rows.reduce((acc, t) => acc + t.notional, 0),
  };

  return {
    ok: true,
    open,
    closed: closedRows.map(toTradeRow),
    stats,
  };
}
