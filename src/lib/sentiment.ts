/** Shared types, prompts and parsing for LLM-based news sentiment analysis. */

export type SentimentLabel = "positive" | "negative" | "neutral" | "mixed";

export interface ScoredItem {
  name?: string;
  term?: string;
  intensity?: number;
  relevance?: number;
}

export interface EntityItem {
  name: string;
  type?: string;
  impact?: string; // "positive" | "negative" | "neutral"
}

export interface StructuredAnalysis {
  title: string;
  sentiment: SentimentLabel;
  score: number; // -1..1
  confidence: number; // 0..1
  summary: string;
  emotions: { name: string; intensity: number }[];
  keywords: { term: string; relevance: number }[];
  entities: EntityItem[];
  reasoning: string;
}

export const ANALYSIS_SYSTEM_PROMPT = `You are an expert news sentiment analyst teaching an NLP study lab. You judge sentiment the way a seasoned financial and general-news reader would: weighing facts, tone, implications, and likely market or public reaction.

Given a news article you respond with ONLY one valid JSON object — no markdown fences, no commentary before or after — matching exactly this schema:
{
  "title": string,                       // concise headline, max 90 chars
  "sentiment": "positive" | "negative" | "neutral" | "mixed",
  "score": number,                       // fine-grained polarity in [-1, 1]; -1 extremely negative, +1 extremely positive
  "confidence": number,                  // your confidence in [0, 1]
  "summary": string,                     // one sentence, max 160 chars
  "emotions": [ {"name": string, "intensity": number} ],   // 2-5 dominant emotions, intensity in [0,1]
  "keywords": [ {"term": string, "relevance": number} ],   // 3-6 key terms or phrases, relevance in [0,1]
  "entities": [ {"name": string, "type": string, "impact": string} ] // up to 5; type in ORG|PERSON|PLACE|PRODUCT|POLICY|ECONOMY|OTHER; impact in positive|negative|neutral
}

Rules:
- "mixed" only when strongly conflicting signals coexist; "score" must still reflect the NET direction.
- Use factual, measured language. Score 0.0 and "neutral" for purely factual items with no clear valence.
- Weigh implications for markets/business/public mood, not just surface wording.
- Output raw JSON only.`;

export function buildAnalysisUserPrompt(text: string, titleHint?: string, source?: string): string {
  const parts: string[] = [];
  if (source) parts.push(`Source: ${source}`);
  if (titleHint) parts.push(`Provided title: ${titleHint}`);
  parts.push(`Article:\n"""\n${text.slice(0, 6000)}\n"""`);
  parts.push("Analyze this article now. Respond with the raw JSON object only.");
  return parts.join("\n\n");
}

export function buildExplanationMessages(a: StructuredAnalysis, text: string): ChatMessageLocal[] {
  const facts = {
    sentiment: a.sentiment,
    score: Number(a.score.toFixed(2)),
    confidence: Number(a.confidence.toFixed(2)),
    top_emotions: a.emotions.slice(0, 3).map((e) => `${e.name} (${e.intensity.toFixed(2)})`),
    key_terms: a.keywords.slice(0, 5).map((k) => k.term),
  };
  return [
    {
      role: "system",
      content:
        "You are a patient NLP tutor. You explain sentiment-analysis verdicts clearly, in plain prose. No markdown, no bullet points, no JSON, no headings — just flowing text.",
    },
    {
      role: "user",
      content: `Article excerpt: """${text.slice(0, 1200)}"""

Structured verdict: ${JSON.stringify(facts)}

Write a concise educational explanation (4-6 sentences) for a student studying sentiment analysis:
1. Why this news reads as "${a.sentiment}" with score ${a.score.toFixed(2)}.
2. Which specific phrases or facts drive the tone.
3. One practical caveat (e.g. sarcasm, missing context, forward-looking uncertainty) if relevant.
Plain prose only.`,
    },
  ];
}

export interface ChatMessageLocal {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Extract the first valid JSON object from raw LLM output (handles ```json fences etc). */
export function extractJsonObject(raw: string): Record<string, unknown> | null {
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(s);
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
      return null;
    } catch {
      return null;
    }
  };
  // 1) direct
  const direct = tryParse(cleaned);
  if (direct) return direct;
  // 2) first { to last }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const sliced = tryParse(cleaned.slice(start, end + 1));
    if (sliced) return sliced;
    // 3) progressive: try trimming trailing garbage line by line
    let candidate = cleaned.slice(start, end + 1);
    for (let i = 0; i < 5; i++) {
      const lastBrace = candidate.lastIndexOf("}");
      if (lastBrace <= 0) break;
      candidate = candidate.slice(0, lastBrace + 1);
      const parsed = tryParse(candidate);
      if (parsed) return parsed;
      candidate = candidate.slice(0, -1);
    }
  }
  return null;
}

const VALID_SENTIMENTS: SentimentLabel[] = ["positive", "negative", "neutral", "mixed"];

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function cleanStr(v: unknown, maxLen: number, fallback = ""): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return fallback;
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

/** Normalize a raw JSON object into a safe StructuredAnalysis. */
export function normalizeAnalysis(raw: Record<string, unknown>, fallbackTitle: string): StructuredAnalysis {
  const sentimentRaw = cleanStr(raw.sentiment, 20).toLowerCase() as SentimentLabel;
  const sentiment = VALID_SENTIMENTS.includes(sentimentRaw) ? sentimentRaw : "neutral";

  const emotionsRaw = Array.isArray(raw.emotions) ? raw.emotions : [];
  const emotions = emotionsRaw
    .slice(0, 6)
    .map((e) => {
      const o = (e ?? {}) as Record<string, unknown>;
      return { name: cleanStr(o.name, 40), intensity: clampNum(o.intensity, 0, 1, 0.5) };
    })
    .filter((e) => e.name);

  const keywordsRaw = Array.isArray(raw.keywords) ? raw.keywords : [];
  const keywords = keywordsRaw
    .slice(0, 8)
    .map((k) => {
      const o = (k ?? {}) as Record<string, unknown>;
      return { term: cleanStr(o.term, 60), relevance: clampNum(o.relevance, 0, 1, 0.6) };
    })
    .filter((k) => k.term);

  const entitiesRaw = Array.isArray(raw.entities) ? raw.entities : [];
  const entities = entitiesRaw
    .slice(0, 6)
    .map((e) => {
      const o = (e ?? {}) as Record<string, unknown>;
      const impact = cleanStr(o.impact, 20).toLowerCase();
      return {
        name: cleanStr(o.name, 80),
        type: cleanStr(o.type, 20).toUpperCase() || "OTHER",
        impact: (VALID_SENTIMENTS.includes(impact as SentimentLabel) ? impact : "neutral") as string,
      };
    })
    .filter((e) => e.name);

  return {
    title: cleanStr(raw.title, 120, fallbackTitle),
    sentiment,
    score: clampNum(raw.score, -1, 1, 0),
    confidence: clampNum(raw.confidence, 0, 1, 0.5),
    summary: cleanStr(raw.summary, 240),
    emotions,
    keywords,
    entities,
    reasoning: cleanStr(raw.reasoning, 800),
  };
}

export const QUIZ_TOPICS = [
  "central banking and interest rates",
  "an electric vehicle maker's quarterly results",
  "a breakthrough in renewable energy",
  "a major tech company layoffs announcement",
  "a sports team winning a championship",
  "a supply chain disruption at a retailer",
  "a pharmaceutical trial success",
  "a cybersecurity breach at a bank",
  "a housing market report",
  "a celebrity charity event",
  "an airline merger announcement",
  "agricultural commodity price swings",
  "a space launch milestone",
  "an industrial strike at a factory",
  "a government infrastructure spending bill",
];

export function quizGenerationPrompt(topic: string): ChatMessageLocal[] {
  return [
    {
      role: "system",
      content:
        'You generate realistic-sounding fictional news snippets for a sentiment-analysis study game. Respond with ONLY a JSON object: {"headline": string (max 110 chars), "body": string (2-3 sentences, journalistic tone), "sentiment": "positive"|"negative"|"neutral"|"mixed", "explanation": string (1-2 sentences why, mentioning the tone cues)}. No markdown fences.',
    },
    {
      role: "user",
      content: `Write a short fictional news item about ${topic}. Vary the sentiment between positive, negative, neutral and mixed naturally (pick whichever fits the scenario you invent). Output raw JSON only.`,
    },
  ];
}

export function quizNormalize(raw: Record<string, unknown>): {
  headline: string;
  body: string;
  sentiment: SentimentLabel;
  explanation: string;
} {
  const s = cleanStr(raw.sentiment, 20).toLowerCase() as SentimentLabel;
  return {
    headline: cleanStr(raw.headline, 160, "Untitled news item"),
    body: cleanStr(raw.body, 800),
    sentiment: VALID_SENTIMENTS.includes(s) ? s : "neutral",
    explanation: cleanStr(raw.explanation, 600),
  };
}
