import { db } from "@/lib/db";
import { fetchTicker24h, ClientError } from "@/lib/binance";
import { buildTradesResponse, toOpenTradeRow } from "@/lib/trades";
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
 * POST /api/trades  { signalId, notional }
 * Opens a simulated trade from a saved signal, filling at the live market price.
 */
export async function POST(req: Request) {
  let body: { signalId?: unknown; notional?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const signalId = typeof body.signalId === "string" ? body.signalId.trim() : "";
  const notional = typeof body.notional === "number" ? body.notional : Number(body.notional);

  if (!signalId) return Response.json({ error: "signalId is required." }, { status: 400 });
  if (!Number.isFinite(notional) || notional < 10 || notional > 1_000_000) {
    return Response.json({ error: "Position size must be between 10 and 1,000,000 USDT." }, { status: 400 });
  }

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

    const existing = await db.trade.findFirst({
      where: { symbol: signal.symbol, status: "OPEN" },
    });
    if (existing) {
      return Response.json(
        { error: `You already have an open paper trade for ${signal.symbol} — close it first.` },
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

    const quantity = Math.max(1e-8, Math.round((notional / price) * 1e6) / 1e6);

    const trade = await db.trade.create({
      data: {
        signalId: signal.id,
        symbol: signal.symbol,
        direction: signal.direction,
        entryPrice: price,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
        quantity,
        notional,
      },
    });

    return Response.json({ ok: true, trade: toOpenTradeRow(trade, price) }, { status: 201 });
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
