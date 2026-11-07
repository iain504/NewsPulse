/**
 * Next.js instrumentation hook — runs once when the server process boots.
 *
 * If the persisted engine config says "armed", the automation engine
 * (auto-scan + auto-trade + SL/TP settlement) starts here, so it keeps
 * working with no browser open.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { ensureEngine } = await import("@/lib/engine");
    await ensureEngine();
  } catch {
    // never block server startup — API routes re-arm on demand
  }
}
