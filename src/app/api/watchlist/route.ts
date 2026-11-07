import { db } from "@/lib/db";
import { fetchTicker24h, ClientError, isValidSymbol } from "@/lib/binance";
import { DEFAULT_SYMBOLS } from "@/lib/types";

export const dynamic = "force-dynamic";

/** GET /api/watchlist — saved symbols; seeds sensible defaults on first load. */
export async function GET() {
  try {
    let items = await db.watchItem.findMany({ orderBy: { createdAt: "asc" } });
    if (items.length === 0) {
      await db.watchItem.createMany({
        data: DEFAULT_SYMBOLS.map((symbol) => ({ symbol })),
      });
      items = await db.watchItem.findMany({ orderBy: { createdAt: "asc" } });
    }
    return Response.json({
      ok: true,
      items: items.map((i) => ({
        id: i.id,
        symbol: i.symbol,
        scan: i.scan,
        createdAt: i.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to load watchlist." },
      { status: 500 },
    );
  }
}

/** POST /api/watchlist  { symbol } — validate against Binance, then persist. */
export async function POST(req: Request) {
  let body: { symbol?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const symbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  if (!isValidSymbol(symbol)) {
    return Response.json({ error: "Invalid symbol format — try e.g. LINKUSDT." }, { status: 400 });
  }

  try {
    const existing = await db.watchItem.findUnique({ where: { symbol } });
    if (existing) {
      return Response.json(
        { error: `${symbol} is already on the watchlist.` },
        { status: 409 },
      );
    }

    // Verify the ticker actually exists on Binance before saving.
    try {
      await fetchTicker24h(symbol);
    } catch (err) {
      const msg =
        err instanceof ClientError
          ? `${symbol} not found on Binance — check the ticker.`
          : "Could not verify the symbol on Binance — try again.";
      return Response.json({ error: msg }, { status: err instanceof ClientError ? 400 : 502 });
    }

    const item = await db.watchItem.create({ data: { symbol } });
    return Response.json(
      { ok: true, item: { id: item.id, symbol: item.symbol, scan: item.scan, createdAt: item.createdAt.toISOString() } },
      { status: 201 },
    );
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to add symbol." },
      { status: 500 },
    );
  }
}

/** PATCH /api/watchlist  { symbol, scan } — toggle inclusion in the auto-scan loop. */
export async function PATCH(req: Request) {
  let body: { symbol?: unknown; scan?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const symbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  const scan = typeof body.scan === "boolean" ? body.scan : undefined;

  if (!isValidSymbol(symbol) || scan === undefined) {
    return Response.json({ error: "Provide a valid symbol and a boolean `scan`." }, { status: 400 });
  }

  try {
    const item = await db.watchItem.update({ where: { symbol }, data: { scan } });
    return Response.json({
      ok: true,
      item: { id: item.id, symbol: item.symbol, scan: item.scan, createdAt: item.createdAt.toISOString() },
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to update symbol." },
      { status: 500 },
    );
  }
}

/** DELETE /api/watchlist?symbol=BTCUSDT */
export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const symbol = url.searchParams.get("symbol")?.trim().toUpperCase() ?? "";

  if (!isValidSymbol(symbol)) {
    return Response.json({ error: "Provide a valid `symbol` query parameter." }, { status: 400 });
  }

  try {
    await db.watchItem.deleteMany({ where: { symbol } });
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to remove symbol." },
      { status: 500 },
    );
  }
}
