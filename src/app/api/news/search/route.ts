import { NextRequest, NextResponse } from "next/server";
import { searchNews } from "@/lib/news";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** POST /api/news/search — find recent news for a topic. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { topic?: string; count?: number };
  const topic = (body.topic ?? "").trim().slice(0, 80);

  if (!topic) {
    return NextResponse.json({ ok: false, error: "Topic is required" }, { status: 400 });
  }

  try {
    const results = await searchNews(topic, body.count ?? 10);
    return NextResponse.json({ ok: true, topic, results });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "News search failed" },
      { status: 502 }
    );
  }
}
