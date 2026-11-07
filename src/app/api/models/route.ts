import { NextResponse } from "next/server";
import { listModels } from "@/lib/edgezero";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const models = await listModels();
    return NextResponse.json({
      ok: true,
      models: models.map((m) => ({
        id: m.id,
        ownedBy: m.owned_by ?? "edge0-local",
        meta: m.meta ?? {},
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, models: [], error: err instanceof Error ? err.message : "Failed to reach edgezero API" },
      { status: 502 }
    );
  }
}
