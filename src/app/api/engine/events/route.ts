import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * GET /api/engine/events?limit=30 — recent engine activity (scans, verdicts,
 * skips, auto-opens, closes, errors) so the UI can replay everything that
 * happened while the browser was closed.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limitRaw = Number(url.searchParams.get("limit") ?? "30");
  const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, Math.round(limitRaw))) : 30;

  try {
    const rows = await db.engineEvent.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return Response.json({
      ok: true,
      events: rows.map((e) => ({
        id: e.id,
        type: e.type,
        symbol: e.symbol,
        message: e.message,
        createdAt: e.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to load engine events." },
      { status: 500 },
    );
  }
}
