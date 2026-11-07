import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** POST /api/quiz/answer — submit a guess, get the verdict. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { roundId?: string; guess?: string };
  const { roundId, guess } = body;

  if (!roundId || !guess) {
    return NextResponse.json({ ok: false, error: "roundId and guess are required" }, { status: 400 });
  }

  const round = await db.quizRound.findUnique({ where: { id: roundId } });
  if (!round) {
    return NextResponse.json({ ok: false, error: "Round not found" }, { status: 404 });
  }
  if (round.answered) {
    return NextResponse.json({
      ok: true,
      alreadyAnswered: true,
      aiSentiment: round.aiSentiment,
      correct: round.correct,
      explanation: round.explanation,
    });
  }

  const correct = round.aiSentiment === guess;
  await db.quizRound.update({
    where: { id: roundId },
    data: { userGuess: guess, correct, answered: true },
  });

  return NextResponse.json({
    ok: true,
    aiSentiment: round.aiSentiment,
    correct,
    explanation: round.explanation,
  });
}
