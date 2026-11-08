import { isValidSymbol } from "@/lib/binance";
import { getTicker24hFromFeed, ensureSymbols, resolveSpotPrices } from "@/lib/market-feed";

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

  // make sure every requested symbol streams over the WebSocket feed
  ensureSymbols(symbols);

  const tickers = symbols.map((symbol) => {
    const feed = getTicker24hFromFeed(symbol);
    if (feed) {
      return {
        symbol,
        lastPrice: feed.lastPrice,
        priceChange: feed.priceChange,
        priceChangePercent: feed.priceChangePercent,
        highPrice: feed.highPrice,
        lowPrice: feed.lowPrice,
        quoteVolume: feed.quoteVolume,
      };
    }
    return null;
  });

  // fallback for symbols the feed doesn't know yet (freshly added, feed down)
  const missing = symbols.filter((s, i) => tickers[i] === null);
  const rest = new Map<string, { lastPrice: number; priceChange: number; priceChangePercent: number; highPrice: number; lowPrice: number; quoteVolume: number }>();
  if (missing.length > 0) {
    try {
      const { fetchTickers24h } = await import("@/lib/binance");
      for (const t of await fetchTickers24h(missing)) rest.set(t.symbol, t);
    } catch {
      // banned / budget exhausted — cached closes still provide a price
    }
  }
  if (missing.length > 0) {
    const prices = await resolveSpotPrices(missing);
    for (const s of missing) {
      const t = rest.get(s);
      if (t) {
        tickers[symbols.indexOf(s)] = { symbol: s, ...t };
        continue;
      }
      const p = prices.get(s);
      if (p && p > 0) {
        tickers[symbols.indexOf(s)] = {
          symbol: s,
          lastPrice: p,
          priceChange: 0,
          priceChangePercent: 0,
          highPrice: p,
          lowPrice: p,
          quoteVolume: 0,
        };
      }
    }
  }

  return Response.json({ ok: true, tickers: tickers.filter((t) => t !== null) });
}
