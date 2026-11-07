/**
 * Engine event log — tiny shared module so trades.ts, the API routes and the
 * background engine can all append activity lines without circular imports.
 */

import { db } from "@/lib/db";

export type EngineEventType = "scan" | "signal" | "open" | "skip" | "close" | "error" | "info";

export interface EngineEventInput {
  type: EngineEventType;
  symbol?: string | null;
  message: string;
}

/** Append one line to the engine activity log, keeping the table bounded. */
export async function logEngineEvent(input: EngineEventInput): Promise<void> {
  try {
    await db.engineEvent.create({
      data: {
        type: input.type,
        symbol: input.symbol ?? null,
        message: input.message.slice(0, 500),
      },
    });
    await pruneEngineEvents();
  } catch {
    // the activity log must never break trading or scanning
  }
}

/** Keep at most the newest MAX_ENGINE_EVENTS rows. */
const MAX_ENGINE_EVENTS = 400;

async function pruneEngineEvents(): Promise<void> {
  // cheap probabilistic prune — runs on ~1 in 10 inserts
  if (Math.random() > 0.1) return;
  const keep = await db.engineEvent.findMany({
    orderBy: { createdAt: "desc" },
    skip: MAX_ENGINE_EVENTS - 1,
    take: 1,
    select: { createdAt: true },
  });
  if (keep.length > 0) {
    await db.engineEvent.deleteMany({ where: { createdAt: { lte: keep[0].createdAt } } });
  }
}
