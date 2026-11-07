import { db } from "@/lib/db";
import { fetchTicker24h, ClientError } from "@/lib/binance";
import { accountEquity, buildTradesResponse, toOpenTradeRow } from "@/lib/trades";
import { computeSizing, roundQty } from "@/lib/sizing";
import { roundPrice } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * GET /api/trades
 * Evaluates all open paper trades against the live Binance price (auto-closing
 * any that touched SL/TP) and returns open positions, history and stats.
 */
export async function GET() {
  try {
    const res = await buildTradesResponse();
    return Response.json(res);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to load trades." },
      { status: 500 },
    );
  }
}

/**
 * POST /api/trades  { signalId, autoSize?, notional?, minConfidence?, source? }
 *
 * Opens a simulated trade from a saved signal, filling at the live market price.
 *
 * Sizing modes:
 *  - autoSize: true  → confidence-driven risk engine: the position is sized so a
 *    stop-loss hit costs riskPct % of equity, where riskPct = 1% × multiplier and
 *    the multiplier scales 0.5×…2× linearly with the signal's confidence.
 *  - autoSize: false → fixed notional in USDT (manual picker).
 *
 * Either way the trade stores a sizing snapshot (confidence, riskPct, riskAmount)
 * so the trade history can show exactly how much was risked and why.
 *
 * Single-position mode: only ONE trade may be open at a time (long or short).
 */
export async function POST(req: Request) {
  let body: {
    signalId?: unknown;
    autoSize?: unknown;
    notional?: unknown;
    minConfidence?: unknown;
    source?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const signalId = typeof body.signalId === "string" ? body.signalId.trim() : "";
  const autoSize = body.autoSize === true;
  const source = body.source === "AUTO" ? "AUTO" : "MANUAL";
  // Floor of the confidence → risk curve (defaults to the auto-trade threshold).
  const minConfidenceRaw = typeof body.minConfidence === "number" ? body.minConfidence : 0.7;
  const minConfidence = Math.min(0.95, Math.max(0.3, minConfidenceRaw));

  let notional: number | null = null;
  if (!autoSize) {
    const raw = typeof body.notional === "number" ? body.notional : Number(body.notional);
    if (!Number.isFinite(raw) || raw < 10 || raw > 1_000_000) {
      return Response.json(
        { error: "Position size must be between 10 and 1,000,000 USDT." },
        { status: 400 },
      );
    }
    notional = raw;
  }

  if (!signalId) return Response.json({ error: "signalId is required." }, { status: 400 });

  try {
    const signal = await db.signal.findUnique({ where: { id: signalId } });
    if (!signal) {
      return Response.json({ error: "Signal not found — it may have been deleted." }, { status: 404 });
    }
    if (signal.direction !== "BUY" && signal.direction !== "SELL") {
      return Response.json(
        { error: "This signal is a WAIT — there is no trade to simulate." },
        { status: 400 },
      );
    }
    if (!(signal.stopLoss > 0) || !(signal.takeProfit > 0)) {
      return Response.json({ error: "Signal is missing stop-loss / take-profit levels." }, { status: 400 });
    }
    const isBuy = signal.direction === "BUY";
    if (isBuy ? signal.stopLoss >= signal.takeProfit : signal.stopLoss <= signal.takeProfit) {
      return Response.json({ error: "Signal has inverted SL/TP levels — analyze again." }, { status: 400 });
    }

    // Single-position mode — one trade at a side at a time (long OR short, any symbol).
    const existing = await db.trade.findFirst({ where: { status: "OPEN" } });
    if (existing) {
      return Response.json(
        {
          error: `Single-position mode — ${existing.symbol} ${existing.direction === "BUY" ? "long" : "short"} is still open. Close it before opening another trade.`,
          openSymbol: existing.symbol,
        },
        { status: 409 },
      );
    }

    let price: number;
    try {
      price = (await fetchTicker24h(signal.symbol)).lastPrice;
    } catch (err) {
      const msg = err instanceof ClientError ? err.message : "Live price unavailable — try again.";
      return Response.json({ error: msg }, { status: 502 });
    }
    if (!(price > 0)) {
      return Response.json({ error: "Live price unavailable — try again." }, { status: 502 });
    }

    // Guard against fills that would instantly resolve the position.
    const pastStop = isBuy ? price <= signal.stopLoss : price >= signal.stopLoss;
    const pastTarget = isBuy ? price >= signal.takeProfit : price <= signal.takeProfit;
    if (pastStop) {
      return Response.json(
        { error: `Market has moved past this signal's stop-loss (${roundPrice(signal.stopLoss)}) — analyze again for a fresh setup.` },
        { status: 400 },
      );
    }
    if (pastTarget) {
      return Response.json(
        { error: `Market is already beyond this signal's take-profit (${roundPrice(signal.takeProfit)}) — analyze again.` },
        { status: 400 },
      );
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
        return Response.json(
          { error: "Could not size this trade — stop-loss too close to the live price." },
          { status: 400 },
        );
      }
      positionSize = sizing.notional;
    } else {
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
      return Response.json({ error: "Trade vanished right after creation." }, { status: 500 });
    }

    return Response.json(
      { ok: true, trade: toOpenTradeRow(enriched, price), riskPct, riskAmount },
      { status: 201 },
    );
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to open trade." },
      { status: 500 },
    );
  }
}

/** DELETE /api/trades?id=...  |  ?closed=1 (clear history)  |  ?all=1 (reset account). */
export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const all = url.searchParams.get("all");
  const closed = url.searchParams.get("closed");

  try {
    if (all === "1") {
      await db.trade.deleteMany({});
      return Response.json({ ok: true });
    }
    if (closed === "1") {
      await db.trade.deleteMany({ where: { status: "CLOSED" } });
      return Response.json({ ok: true });
    }
    if (!id) {
      return Response.json({ error: "Provide id, closed=1 or all=1." }, { status: 400 });
    }
    await db.trade.delete({ where: { id } });
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to delete trade." },
      { status: 500 },
    );
  }
}
