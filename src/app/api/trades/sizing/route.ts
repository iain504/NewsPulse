import { db } from "@/lib/db";
import { fetchTicker24h } from "@/lib/binance";
import { accountEquity } from "@/lib/trades";
import { computeSizing, roundQty } from "@/lib/sizing";
import type { SizingPreview, SizingResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/trades/sizing?signalId=…[&notional=…][&minConfidence=0.7]
 *
 * Live preview of the confidence-driven risk sizing engine:
 *  - auto  → position sized so a stop-loss hit costs BASE_RISK_PCT × confidence
 *            multiplier percent of the account equity.
 *  - fixed → risk snapshot for a user-chosen USDT notional (when provided).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const signalId = (url.searchParams.get("signalId") ?? "").trim();
  const minConfRaw = Number(url.searchParams.get("minConfidence") ?? "0.7");
  const minConfidence = Number.isFinite(minConfRaw)
    ? Math.min(0.95, Math.max(0.3, minConfRaw))
    : 0.7;
  const notionalRaw = Number(url.searchParams.get("notional") ?? "");
  const hasNotional = Number.isFinite(notionalRaw) && notionalRaw >= 10;

  if (!signalId) {
    return Response.json({ error: "signalId is required." }, { status: 400 });
  }

  try {
    const signal = await db.signal.findUnique({ where: { id: signalId } });
    if (!signal) {
      return Response.json({ error: "Signal not found." }, { status: 404 });
    }
    if (signal.direction === "WAIT" || !(signal.stopLoss > 0)) {
      return Response.json({ ok: true, equity: 0, auto: null, fixed: null });
    }

    const [equity, ticker] = await Promise.all([
      accountEquity(),
      fetchTicker24h(signal.symbol).catch(() => null),
    ]);
    const fillPrice = ticker?.lastPrice ?? signal.price;
    if (!(fillPrice > 0) || !(equity > 0)) {
      return Response.json({ ok: true, equity, auto: null, fixed: null });
    }

    const sizing = computeSizing({
      equity,
      fillPrice,
      stopLoss: signal.stopLoss,
      confidence: signal.confidence,
      minConfidence,
    });

    const auto = sizing
      ? {
          confidence: signal.confidence * 100,
          multiplier: sizing.multiplier,
          riskPct: (sizing.riskAmount / equity) * 100,
          riskAmount: sizing.riskAmount,
          stopDistance: sizing.stopDistance,
          stopPct: sizing.stopPct,
          notional: sizing.notional,
          quantity: sizing.quantity,
          capped: sizing.capped,
          fillPrice,
        }
      : null;

    let fixed: SizingPreview | null = null;
    if (hasNotional) {
      const stopDistance = Math.abs(fillPrice - signal.stopLoss);
      if (stopDistance > 0) {
        const riskAmount = (notionalRaw / fillPrice) * stopDistance;
        fixed = {
          confidence: signal.confidence * 100,
          multiplier: 1,
          riskPct: (riskAmount / equity) * 100,
          riskAmount,
          stopDistance,
          stopPct: (stopDistance / fillPrice) * 100,
          notional: notionalRaw,
          quantity: roundQty(notionalRaw / fillPrice),
          capped: false,
          fillPrice,
        };
      }
    }

    const res: SizingResponse = { ok: true, equity, auto, fixed };
    return Response.json(res);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to compute sizing." },
      { status: 500 },
    );
  }
}
