import { NextRequest, NextResponse } from "next/server";
import { readArticle } from "@/lib/news";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** POST /api/news/fetch — extract readable article text from a URL. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { url?: string };
  const url = (body.url ?? "").trim();

  if (!url) {
    return NextResponse.json({ ok: false, error: "URL is required" }, { status: 400 });
  }

  try {
    const article = await readArticle(url);
    return NextResponse.json({ ok: true, article });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Failed to read article" },
      { status: 502 }
    );
  }
}
