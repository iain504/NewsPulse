import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** GET /api/analyses?limit=50&sentiment=positive — list stored analyses (newest first) */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const limit = Math.min(200, Math.max(1, parseInt(sp.get("limit") ?? "50", 10) || 50));
  const sentiment = sp.get("sentiment");

  const where = sentiment && sentiment !== "all" ? { sentiment } : undefined;

  const analyses = await db.analysis.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      title: true,
      source: true,
      sentiment: true,
      score: true,
      confidence: true,
      summary: true,
      emotions: true,
      keywords: true,
      entities: true,
      model: true,
      latencyMs: true,
      createdAt: true,
    },
  });

  return NextResponse.json({ ok: true, analyses });
}

/** DELETE /api/analyses?id=... — delete one analysis */
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ ok: false, error: "Missing id" }, { status: 400 });
  }
  try {
    await db.analysis.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }
}
