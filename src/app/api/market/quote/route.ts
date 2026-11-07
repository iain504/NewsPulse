import { fetchTickers24h, isValidSymbol } from "@/lib/binance";

export const dynamic = "force-dynamic";

/** GET /api/market/quote?symbols=BTCUSDT,ETHUSDT */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = url.searchParams.get("symbols") ?? "";
  const symbols = raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => isValidSymbol(s))
    .slice(0, 12);

  if (symbols.length === 0) {
    return Response.json({ error: "Provide 1-12 valid symbols." }, { status: 400 });
  }

  try {
    const tickers = await fetchTickers24h(symbols);
    return Response.json({ ok: true, tickers });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to load quotes." },
      { status: 502 },
    );
  }
}
