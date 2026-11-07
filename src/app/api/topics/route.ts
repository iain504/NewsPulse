import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** GET /api/topics — list followed topics (oldest first). */
export async function GET() {
  const topics = await db.followedTopic.findMany({ orderBy: { createdAt: "asc" } });
  return NextResponse.json({ ok: true, topics });
}

/** POST /api/topics — follow a topic { name }. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { name?: string };
  const name = (body.name ?? "").trim().slice(0, 60);
  if (!name) {
    return NextResponse.json({ ok: false, error: "Topic name is required" }, { status: 400 });
  }

  try {
    const topic = await db.followedTopic.upsert({
      where: { name },
      update: {},
      create: { name },
    });
    return NextResponse.json({ ok: true, topic });
  } catch {
    return NextResponse.json({ ok: false, error: "Could not follow topic" }, { status: 500 });
  }
}

/** DELETE /api/topics?id=... — unfollow a topic. */
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ ok: false, error: "Missing id" }, { status: 400 });
  }
  try {
    await db.followedTopic.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }
}
