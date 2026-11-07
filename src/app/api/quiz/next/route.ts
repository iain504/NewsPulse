import { NextRequest, NextResponse } from "next/server";
import { chatCompletion } from "@/lib/edgezero";
import { extractJsonObject, QUIZ_TOPICS, quizGenerationPrompt, quizNormalize } from "@/lib/sentiment";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const VALID_MODELS = new Set(["edge0-35b", "edge0-8b"]);

/** POST /api/quiz/next — generate a new practice headline (answer stored server-side). */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { model?: string };
  const model = VALID_MODELS.has(body.model ?? "") ? (body.model as string) : "edge0-8b";

  const topic = QUIZ_TOPICS[Math.floor(Math.random() * QUIZ_TOPICS.length)];

  try {
    const raw = await chatCompletion({
      model,
      messages: quizGenerationPrompt(topic),
      temperature: 0.9,
      maxTokens: 400,
      timeoutMs: 90_000,
    });
    const parsed = extractJsonObject(raw);
    if (!parsed) throw new Error("Model returned invalid quiz JSON.");
    const quiz = quizNormalize(parsed);

    const round = await db.quizRound.create({
      data: {
        headline: quiz.headline,
        body: quiz.body,
        aiSentiment: quiz.sentiment,
        explanation: quiz.explanation,
        model,
      },
    });

    // The answer (aiSentiment) is NOT returned until the user answers.
    return NextResponse.json({
      ok: true,
      round: { id: round.id, headline: round.headline, body: round.body },
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Failed to generate quiz round." },
      { status: 502 }
    );
  }
}
