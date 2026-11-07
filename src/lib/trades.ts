/**
 * Server-side paper-trading engine.
 *
 * Trades fill at the live Binance spot price and are evaluated on every read:
 * when the market price touches a position's stop-loss or take-profit the
 * position is closed and P&L is crystallised into the database.
 */

import { db } from "@/lib/db";
import { fetchTickers24h } from "@/lib/binance";
import { PAPER_START_BALANCE, type OpenTradeRow, type TradeRow, type TradeStats, type TradesResponse, type TradeExitReason } from "@/lib/types";
import type { Trade } from "@prisma/client";

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

export function toTradeRow(t: Trade): TradeRow {
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
    status: t.status === "CLOSED" ? "CLOSED" : "OPEN",
    source: t.source === "AUTO" ? "AUTO" : "MANUAL",
    exitPrice: t.exitPrice,
    pnl: t.pnl,
    pnlPct: t.pnlPct,
    exitReason: (t.exitReason as TradeExitReason | null) ?? null,
    openedAt: t.openedAt.toISOString(),
    closedAt: t.closedAt ? t.closedAt.toISOString() : null,
  };
}

export function toOpenTradeRow(t: Trade, currentPrice: number): OpenTradeRow {
  const { pnl, pnlPct } = calcPnl(t.direction, t.entryPrice, currentPrice, t.quantity, t.notional);
  return {
    ...toTradeRow(t),
    currentPrice,
    unrealizedPnl: pnl,
    unrealizedPct: pnlPct,
    progressPct: levelProgress(t.direction, t.stopLoss, t.takeProfit, currentPrice),
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
 * Evaluate all OPEN trades against the live market price.
 * A position whose price touched its stop-loss or take-profit is closed and
 * its P&L stored. If both levels sit inside the last move, the stop-loss is
 * assumed first (conservative fill).
 */
export async function evaluateOpenTrades(): Promise<void> {
  const open = await db.trade.findMany({ where: { status: "OPEN" } });
  if (open.length === 0) return;

  const priceMap = await fetchPriceMap(open.map((t) => t.symbol));

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

    await db.trade.update({
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
  }
}

/** Evaluate, then assemble the full account snapshot for the UI. */
export async function buildTradesResponse(): Promise<TradesResponse> {
  await evaluateOpenTrades();

  const rows = await db.trade.findMany({ orderBy: [{ openedAt: "desc" }] });
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
