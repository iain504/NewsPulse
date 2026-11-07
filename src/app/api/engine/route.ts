import { ensureEngine, getEngineStatus, updateEngineConfig } from "@/lib/engine";

export const dynamic = "force-dynamic";

/**
 * GET /api/engine — current persisted engine state (armed flags, thresholds,
 * schedule, open position). The UI polls this so armed status survives
 * reloads and any device.
 */
export async function GET() {
  try {
    await ensureEngine(); // self-heal if instrumentation didn't run
    const status = await getEngineStatus();
    return Response.json({ ok: true, ...status });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to read engine state." },
      { status: 500 },
    );
  }
}

/**
 * POST /api/engine — update the persisted engine configuration.
 * body: { armed?, autoScan?, autoTrade?, minConfidence?, minRR?, scanMinutes?, interval?, riskProfile?, model? }
 *
 * Everything is stored in the database, so the engine keeps running exactly
 * as configured — no browser required.
 */
export async function POST(req: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const patch: Parameters<typeof updateEngineConfig>[0] = {};
  if (typeof body.armed === "boolean") patch.armed = body.armed;
  if (typeof body.autoScan === "boolean") patch.autoScan = body.autoScan;
  if (typeof body.autoTrade === "boolean") patch.autoTrade = body.autoTrade;
  if (typeof body.minConfidence === "number" && Number.isFinite(body.minConfidence)) {
    patch.minConfidence = body.minConfidence;
  }
  if (typeof body.minRR === "number" && Number.isFinite(body.minRR)) patch.minRR = body.minRR;
  if (typeof body.scanMinutes === "number" && Number.isFinite(body.scanMinutes)) {
    patch.scanMinutes = body.scanMinutes;
  }
  if (typeof body.interval === "string") patch.interval = body.interval;
  if (typeof body.riskProfile === "string") patch.riskProfile = body.riskProfile;
  if (typeof body.model === "string") patch.model = body.model;

  if (Object.keys(patch).length === 0) {
    return Response.json({ error: "No valid engine settings provided." }, { status: 400 });
  }

  try {
    const status = await updateEngineConfig(patch);
    return Response.json({ ok: true, ...status });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to update the engine." },
      { status: 500 },
    );
  }
}
