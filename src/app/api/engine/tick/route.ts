import { triggerEngineCycle } from "@/lib/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/engine/tick — force one scan cycle right now (the "Run now"
 * button). The cycle runs server-side; the response only says whether it
 * started, results arrive via the events feed / signal history.
 */
export async function POST() {
  try {
    const res = await triggerEngineCycle();
    if (!res.started) {
      return Response.json({ ok: false, reason: "A scan cycle is already running." });
    }
    return Response.json({ ok: true, started: true });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to trigger the engine." },
      { status: 500 },
    );
  }
}
