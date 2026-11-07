import { chatCompletion, streamChat } from "@/lib/edgezero";
import {
  ANALYSIS_SYSTEM_PROMPT,
  buildAnalysisUserPrompt,
  buildExplanationMessages,
  extractJsonObject,
  normalizeAnalysis,
  StructuredAnalysis,
} from "@/lib/sentiment";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const VALID_MODELS = new Set(["edge0-35b", "edge0-8b"]);

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    text?: string;
    title?: string;
    source?: string;
    model?: string;
  };

  const text = (body.text ?? "").trim();
  const model = VALID_MODELS.has(body.model ?? "") ? (body.model as string) : "edge0-35b";
  const titleHint = (body.title ?? "").trim() || undefined;
  const source = (body.source ?? "").trim() || undefined;

  if (text.length < 20) {
    return new Response(JSON.stringify({ error: "Please provide at least 20 characters of news text." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const startedAt = Date.now();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(sse(event, data)));
      };

      let analysis: StructuredAnalysis | null = null;

      try {
        // Phase 1 — structured verdict (non-streaming)
        const raw = await chatCompletion({
          model,
          messages: [
            { role: "system", content: ANALYSIS_SYSTEM_PROMPT },
            { role: "user", content: buildAnalysisUserPrompt(text, titleHint, source) },
          ],
          temperature: 0.15,
          maxTokens: 900,
          timeoutMs: 120_000,
        });

        const parsed = extractJsonObject(raw);
        if (!parsed) throw new Error("Model did not return valid JSON analysis.");
        analysis = normalizeAnalysis(parsed, titleHint ?? text.slice(0, 80));
        const latencyMs = Date.now() - startedAt;

        send("analysis", { analysis, latencyMs, model });

        // Phase 2 — streamed tutor explanation (SSE from edgezero)
        try {
          for await (const delta of streamChat({
            model,
            messages: buildExplanationMessages(analysis, text),
            temperature: 0.5,
            maxTokens: 500,
            timeoutMs: 120_000,
          })) {
            send("delta", { t: delta });
          }
        } catch {
          send("delta", { t: "" }); // explanation failed — non-fatal
        }

        // Phase 3 — persist
        const saved = await db.analysis.create({
          data: {
            title: analysis.title,
            source: source ?? null,
            content: text.slice(0, 8000),
            sentiment: analysis.sentiment,
            score: analysis.score,
            confidence: analysis.confidence,
            emotions: JSON.stringify(analysis.emotions),
            keywords: JSON.stringify(analysis.keywords),
            entities: JSON.stringify(analysis.entities),
            summary: analysis.summary,
            reasoning: analysis.reasoning,
            model,
            latencyMs,
          },
        });

        send("done", { id: saved.id, createdAt: saved.createdAt, latencyMs });
      } catch (err) {
        send("error", {
          message: err instanceof Error ? err.message : "Analysis failed unexpectedly.",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
