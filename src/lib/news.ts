/** Server-side news discovery via the Z-AI SDK (web_search + page_reader). */
import ZAI from "z-ai-web-dev-sdk";

export interface NewsItem {
  url: string;
  title: string;
  snippet: string;
  host: string;
  date: string;
  favicon: string;
}

export interface ArticleContent {
  url: string;
  title: string;
  text: string;
  publishedTime?: string;
}

const globalForZai = globalThis as unknown as { zai?: Awaited<ReturnType<typeof ZAI.create>> };

async function getZai() {
  if (!globalForZai.zai) globalForZai.zai = await ZAI.create();
  return globalForZai.zai;
}

/** Search recent news for a topic. */
export async function searchNews(topic: string, count = 10): Promise<NewsItem[]> {
  const zai = await getZai();
  const results = await zai.functions.invoke("web_search", {
    query: `${topic} news latest`,
    num: Math.min(15, Math.max(3, count)),
    recency_days: 14,
  });

  const seen = new Set<string>();
  const items: NewsItem[] = [];
  for (const r of results ?? []) {
    if (!r?.url || !/^https?:\/\//i.test(r.url)) continue;
    const key = r.url.replace(/[#?].*$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      url: r.url,
      title: (r.name ?? "").trim().slice(0, 200),
      snippet: (r.snippet ?? "").trim().slice(0, 400),
      host: (r.host_name ?? "").replace(/^www\./, ""),
      date: r.date ?? "",
      favicon: r.favicon ?? "",
    });
  }
  return items;
}

function htmlToText(html: string): string {
  const raw = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(?:br|\/p|\/div|\/h[1-6]|\/li|\/section|\/article)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");

  // Keep only meaningful lines, collapse the rest
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter((l) => l.length > 0);

  const text = lines.join("\n");
  // Collapse runs of very short nav-ish lines mixed with long ones — keep all, but cap total
  return text.slice(0, 6000).trim();
}

/** Fetch and extract the readable text of an article URL. */
export async function readArticle(url: string): Promise<ArticleContent> {
  if (!/^https?:\/\//i.test(url)) throw new Error("Invalid URL");
  const zai = await getZai();
  const result = await zai.functions.invoke("page_reader", { url });
  const data = result?.data;
  if (!data?.html) throw new Error("Could not read the article page.");

  const text = htmlToText(data.html);
  if (text.length < 80) throw new Error("The page did not contain readable article text.");

  return {
    url,
    title: (data.title ?? "").trim().slice(0, 200),
    text: text.slice(0, 6000),
    publishedTime: data.publishedTime ?? undefined,
  };
}
