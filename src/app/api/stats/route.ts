import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function GET() {
  const since = new Date(Date.now() - 14 * DAY_MS);

  const [total, recent] = await Promise.all([
    db.analysis.findMany({ select: { sentiment: true, score: true, confidence: true, model: true, latencyMs: true, createdAt: true, keywords: true } }),
    db.analysis.findMany({
      orderBy: { createdAt: "desc" },
      take: 8,
      select: { id: true, title: true, sentiment: true, score: true, model: true, createdAt: true },
    }),
  ]);

  const bySentiment: Record<string, number> = { positive: 0, negative: 0, neutral: 0, mixed: 0 };
  const byModel = new Map<string, { count: number; scoreSum: number; latencySum: number }>();
  const dailyMap = new Map<string, { count: number; scoreSum: number }>();
  const keywordCount = new Map<string, number>();

  for (const a of total) {
    bySentiment[a.sentiment] = (bySentiment[a.sentiment] ?? 0) + 1;

    const m = byModel.get(a.model) ?? { count: 0, scoreSum: 0, latencySum: 0 };
    m.count += 1;
    m.scoreSum += a.score;
    m.latencySum += a.latencyMs;
    byModel.set(a.model, m);

    const day = new Date(a.createdAt).toISOString().slice(0, 10);
    const d = dailyMap.get(day) ?? { count: 0, scoreSum: 0 };
    d.count += 1;
    d.scoreSum += a.score;
    dailyMap.set(day, d);

    try {
      const kws = JSON.parse(a.keywords) as { term: string }[];
      for (const k of kws) {
        if (k.term) keywordCount.set(k.term.toLowerCase(), (keywordCount.get(k.term.toLowerCase()) ?? 0) + 1);
      }
    } catch {
      // ignore malformed keyword rows
    }
  }

  // Build a continuous 14-day series
  const daily: { date: string; count: number; avgScore: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const day = new Date(Date.now() - i * DAY_MS).toISOString().slice(0, 10);
    const d = dailyMap.get(day);
    daily.push({
      date: day.slice(5), // MM-DD
      count: d?.count ?? 0,
      avgScore: d && d.count ? Number((d.scoreSum / d.count).toFixed(3)) : 0,
    });
  }

  const avgScore = total.length ? total.reduce((s, a) => s + a.score, 0) / total.length : 0;
  const avgConfidence = total.length ? total.reduce((s, a) => s + a.confidence, 0) / total.length : 0;

  const topKeywords = Array.from(keywordCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([term, count]) => ({ term, count }));

  const models = Array.from(byModel.entries()).map(([model, m]) => ({
    model,
    count: m.count,
    avgScore: Number((m.scoreSum / m.count).toFixed(3)),
    avgLatencyMs: Math.round(m.latencySum / m.count),
  }));

  return NextResponse.json({
    ok: true,
    total: total.length,
    avgScore: Number(avgScore.toFixed(3)),
    avgConfidence: Number(avgConfidence.toFixed(3)),
    bySentiment,
    daily,
    models,
    topKeywords,
    recent,
  });
}
