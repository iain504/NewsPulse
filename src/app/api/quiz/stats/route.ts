import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** GET /api/quiz/stats — the learner's track record on the guessing game. */
export async function GET() {
  const rounds = await db.quizRound.findMany({
    where: { answered: true },
    orderBy: { createdAt: "asc" },
    select: { correct: true, userGuess: true, aiSentiment: true, createdAt: true },
  });

  const total = rounds.length;
  const correctCount = rounds.filter((r) => r.correct).length;

  // Current streak = consecutive correct answers counting back from the most recent
  let streak = 0;
  for (let i = rounds.length - 1; i >= 0; i--) {
    if (rounds[i].correct) streak++;
    else break;
  }
  let bestStreak = 0;
  let run = 0;
  for (const r of rounds) {
    if (r.correct) {
      run++;
      bestStreak = Math.max(bestStreak, run);
    } else run = 0;
  }

  const byGuess: Record<string, { guessed: number; correct: number }> = {};
  for (const r of rounds) {
    const key = r.userGuess || "unknown";
    byGuess[key] = byGuess[key] ?? { guessed: 0, correct: 0 };
    byGuess[key].guessed++;
    if (r.correct) byGuess[key].correct++;
  }

  return NextResponse.json({
    ok: true,
    total,
    correct: correctCount,
    accuracy: total ? Number((correctCount / total).toFixed(3)) : 0,
    streak,
    bestStreak,
    byGuess,
    history: rounds.slice(-12).reverse().map((r) => ({
      userGuess: r.userGuess,
      aiSentiment: r.aiSentiment,
      correct: r.correct,
      createdAt: r.createdAt,
    })),
  });
}
