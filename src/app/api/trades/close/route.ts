import { db } from "@/lib/db";
import { resolveSpotPrice } from "@/lib/trades";
import { calcPnl, toTradeRow } from "@/lib/trades";

export const dynamic = "force-dynamic";

/**
 * POST /api/trades/close  { tradeId }
 * Manually close an open paper trade at the current market price.
 */
export async function POST(req: Request) {
  let body: { tradeId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const tradeId = typeof body.tradeId === "string" ? body.tradeId.trim() : "";
  if (!tradeId) return Response.json({ error: "tradeId is required." }, { status: 400 });

  try {
    const trade = await db.trade.findUnique({ where: { id: tradeId } });
    if (!trade) {
      return Response.json({ error: "Trade not found — it may have been deleted." }, { status: 404 });
    }
    if (trade.status !== "OPEN") {
      return Response.json({ error: "This trade is already closed." }, { status: 400 });
    }

    // fill at the best known price: WebSocket feed → cached close → REST
    const price = await resolveSpotPrice(trade.symbol);
    if (!price || !(price > 0)) {
      return Response.json({ error: "Live price unavailable — the market feed is warming up, try again in a moment." }, { status: 502 });
    }

    const { pnl, pnlPct } = calcPnl(trade.direction, trade.entryPrice, price, trade.quantity, trade.notional);

    const updated = await db.trade.update({
      where: { id: trade.id },
      data: {
        status: "CLOSED",
        exitPrice: price,
        pnl,
        pnlPct,
        exitReason: "MANUAL",
        closedAt: new Date(),
      },
    });

    const enriched = await db.trade.findUnique({
      where: { id: updated.id },
      include: { signal: true },
    });
    if (!enriched) {
      return Response.json({ error: "Trade vanished right after closing." }, { status: 500 });
    }

    return Response.json({ ok: true, trade: toTradeRow(enriched) });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to close trade." },
      { status: 500 },
    );
  }
}
