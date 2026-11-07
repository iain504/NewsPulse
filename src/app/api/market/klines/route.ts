import { fetchKlines, fetchTicker24h, isBinanceInterval, isValidSymbol } from "@/lib/binance";

export const dynamic = "force-dynamic";

/** GET /api/market/klines?symbol=BTCUSDT&interval=15m&limit=150 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbol = (url.searchParams.get("symbol") ?? "BTCUSDT").toUpperCase();
  const interval = url.searchParams.get("interval") ?? "15m";
  const limit = parseInt(url.searchParams.get("limit") ?? "150", 10);

  if (!isValidSymbol(symbol)) {
    return Response.json({ error: "Invalid symbol format (e.g. BTCUSDT)." }, { status: 400 });
  }
  if (!isBinanceInterval(interval)) {
    return Response.json({ error: `Invalid interval. Use one of: 5m, 15m, 1h, 4h, 1d.` }, { status: 400 });
  }

  try {
    const [candles, ticker] = await Promise.all([
      fetchKlines(symbol, interval, Number.isFinite(limit) ? limit : 150),
      fetchTicker24h(symbol).catch(() => null),
    ]);
    return Response.json({ ok: true, symbol, interval, candles, ticker });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to load market data." },
      { status: 502 },
    );
  }
}
