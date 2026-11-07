import { db } from "@/lib/db";
import { buildTradesResponse, openTradeFromSignal, toOpenTradeRow } from "@/lib/trades";

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
 * The heavy lifting lives in `openTradeFromSignal` (src/lib/trades.ts) so the
 * background automation engine enforces exactly the same rules:
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
    const res = await openTradeFromSignal({ signalId, autoSize, notional, minConfidence, source });
    if (!res.ok) {
      return Response.json({ error: res.error }, { status: res.status });
    }
    return Response.json(
      {
        ok: true,
        trade: toOpenTradeRow(res.trade, res.trade.entryPrice),
        riskPct: res.riskPct,
        riskAmount: res.riskAmount,
      },
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
