import { db } from "@/lib/db";
import type { SignalDirection, SignalRow } from "@/lib/types";

export const dynamic = "force-dynamic";

function parseList(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** GET /api/signals?symbol=BTCUSDT&limit=40 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbol = url.searchParams.get("symbol")?.trim().toUpperCase() ?? "";
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") ?? "40", 10) || 40));

  try {
    const rows = await db.signal.findMany({
      where: symbol ? { symbol } : undefined,
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    const signals: SignalRow[] = rows.map((r) => ({
      id: r.id,
      symbol: r.symbol,
      interval: r.interval,
      direction: (["BUY", "SELL", "WAIT"].includes(r.direction) ? r.direction : "WAIT") as SignalDirection,
      confidence: r.confidence,
      price: r.price,
      entry: r.entry,
      entryLow: r.entryLow,
      entryHigh: r.entryHigh,
      stopLoss: r.stopLoss,
      takeProfit: r.takeProfit,
      rrRatio: r.rrRatio,
      timeHorizon: r.timeHorizon,
      summary: r.summary,
      reasons: parseList(r.reasons),
      risks: parseList(r.risks),
      rationale: r.rationale,
      model: r.model,
      latencyMs: r.latencyMs,
      source: r.source,
      createdAt: r.createdAt.toISOString(),
    }));

    return Response.json({ ok: true, signals });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to load signals." },
      { status: 500 },
    );
  }
}

/** DELETE /api/signals?id=...  or  DELETE /api/signals?all=1 */
export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const all = url.searchParams.get("all");

  try {
    if (all === "1") {
      await db.signal.deleteMany({});
      return Response.json({ ok: true });
    }
    if (!id) {
      return Response.json({ error: "Provide id or all=1." }, { status: 400 });
    }
    await db.signal.delete({ where: { id } });
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to delete signal." },
      { status: 500 },
    );
  }
}
