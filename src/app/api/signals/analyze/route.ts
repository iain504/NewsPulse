import { chatCompletion, streamChat } from "@/lib/edgezero";
import { isBinanceInterval, isValidSymbol } from "@/lib/binance";
import { getCandles } from "@/lib/candle-store";
import { getTicker24hFromFeed } from "@/lib/market-feed";
import { extractJsonObject } from "@/lib/sentiment";
import { buildMarketSnapshot, buildPlanMessages, buildSignalUserPrompt, normalizeSignal, SIGNAL_SYSTEM_PROMPT, type RiskProfile, type StructuredSignal } from "@/lib/signal";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const VALID_MODELS = new Set(["edge0-35b", "edge0-8b"]);
const RISK_PROFILES = new Set(["conservative", "balanced", "aggressive"]);

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * POST /api/signals/analyze
 * body: { symbol, interval, model, riskProfile, source }
 *
 * Phase 0 — load cached bars (WebSocket-fed) + feed 24h stats, compute indicators (deterministic)
 * Phase 1 — LLM structured verdict: direction / entry / SL / TP (non-streaming JSON)
 * Phase 2 — streamed trading-plan rationale
 * Phase 3 — persist to DB
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    symbol?: string;
    interval?: string;
    model?: string;
    riskProfile?: string;
    source?: string;
  };

  const symbol = (body.symbol ?? "").trim().toUpperCase();
  const interval = body.interval ?? "15m";
  const model = VALID_MODELS.has(body.model ?? "") ? (body.model as string) : "edge0-35b";
  const riskProfile: RiskProfile = RISK_PROFILES.has(body.riskProfile ?? "")
    ? (body.riskProfile as RiskProfile)
    : "balanced";
  const source = body.source === "auto" ? "auto" : "manual";

  if (!isValidSymbol(symbol)) {
    return Response.json({ error: "Invalid symbol (e.g. BTCUSDT)." }, { status: 400 });
  }
  if (!isBinanceInterval(interval)) {
    return Response.json({ error: "Invalid interval (5m, 15m, 1h, 4h, 1d)." }, { status: 400 });
  }

  const startedAt = Date.now();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(sse(event, data)));
      };

      let signal: StructuredSignal | null = null;
      let rationaleText = "";

      try {
        // Phase 0 — market data from the local cache (zero REST weight)
        const { candles: klines, stale } = await getCandles(symbol, interval, 150);
        if (klines.length < 30) {
          throw new Error(
            stale
              ? "Not enough market data cached yet — the WebSocket feed is warming up, retry in a minute."
              : `Only ${klines.length} bars cached for ${symbol} — retry shortly.`,
          );
        }
        const ticker = getTicker24hFromFeed(symbol);
        const snapshot = buildMarketSnapshot(symbol, interval, klines, ticker);
        send("snapshot", { snapshot });

        // Phase 1 — structured verdict from the LLM
        const raw = await chatCompletion({
          model,
          messages: [
            { role: "system", content: SIGNAL_SYSTEM_PROMPT },
            { role: "user", content: buildSignalUserPrompt(snapshot, riskProfile) },
          ],
          temperature: 0.2,
          maxTokens: 900,
          timeoutMs: 150_000,
        });

        const parsed = extractJsonObject(raw);
        if (!parsed) throw new Error("Model did not return a valid signal JSON.");

        signal = normalizeSignal(parsed, snapshot);
        const latencyMs = Date.now() - startedAt;
        send("signal", { signal, latencyMs, model });

        // Phase 2 — streamed trading-plan explanation (non-fatal)
        try {
          for await (const delta of streamChat({
            model,
            messages: buildPlanMessages(signal, snapshot),
            temperature: 0.5,
            maxTokens: 480,
            timeoutMs: 120_000,
          })) {
            rationaleText += delta;
            send("delta", { t: delta });
          }
        } catch {
          send("delta", { t: "" });
        }

        // Phase 3 — persist
        const saved = await db.signal.create({
          data: {
            symbol,
            interval,
            direction: signal.direction,
            confidence: signal.confidence,
            price: snapshot.lastPrice,
            entry: signal.entry,
            entryLow: signal.entryLow,
            entryHigh: signal.entryHigh,
            stopLoss: signal.stopLoss,
            takeProfit: signal.takeProfit,
            rrRatio: signal.rrRatio,
            timeHorizon: signal.timeHorizon,
            summary: signal.summary,
            reasons: JSON.stringify(signal.reasons),
            risks: JSON.stringify(signal.risks),
            indicators: JSON.stringify(snapshot),
            rationale: rationaleText,
            model,
            latencyMs,
            source,
          },
        });

        send("done", { id: saved.id, createdAt: saved.createdAt, latencyMs });
      } catch (err) {
        send("error", {
          message: err instanceof Error ? err.message : "Signal analysis failed unexpectedly.",
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
