/** Shared DTO types between frontend and backend API routes. */

export type SentimentLabel = "positive" | "negative" | "neutral" | "mixed";

export interface StructuredAnalysis {
  title: string;
  sentiment: SentimentLabel;
  score: number; // -1..1
  confidence: number; // 0..1
  summary: string;
  emotions: { name: string; intensity: number }[];
  keywords: { term: string; relevance: number }[];
  entities: { name: string; type: string; impact: string }[];
  reasoning: string;
}

export interface ModelInfo {
  id: string;
  ownedBy: string;
  meta: Record<string, unknown>;
}

export interface AnalysisRow {
  id: string;
  title: string;
  source: string | null;
  sentiment: SentimentLabel;
  score: number;
  confidence: number;
  summary: string;
  emotions: string; // JSON: {name,intensity}[]
  keywords: string; // JSON: {term,relevance}[]
  entities: string | null; // JSON: {name,type,impact}[]
  model: string;
  latencyMs: number;
  createdAt: string;
}

export interface StatsResponse {
  ok: boolean;
  total: number;
  avgScore: number;
  avgConfidence: number;
  bySentiment: Record<SentimentLabel, number>;
  daily: { date: string; count: number; avgScore: number }[];
  models: { model: string; count: number; avgScore: number; avgLatencyMs: number }[];
  topKeywords: { term: string; count: number }[];
  recent: { id: string; title: string; sentiment: SentimentLabel; score: number; model: string; createdAt: string }[];
}

export interface QuizStatsResponse {
  ok: boolean;
  total: number;
  correct: number;
  accuracy: number;
  streak: number;
  bestStreak: number;
  byGuess: Record<string, { guessed: number; correct: number }>;
  history: { userGuess: string; aiSentiment: string; correct: boolean; createdAt: string }[];
}

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

export interface FollowedTopic {
  id: string;
  name: string;
  createdAt: string;
}

export type AnalyzeStreamEvent =
  | { event: "analysis"; data: { analysis: StructuredAnalysis; latencyMs: number; model: string } }
  | { event: "delta"; data: { t: string } }
  | { event: "done"; data: { id: string; createdAt: string; latencyMs: number } }
  | { event: "error"; data: { message: string } };

export const SENTIMENT_META: Record<
  SentimentLabel,
  { label: string; badge: string; dot: string; text: string; bg: string; hex: string }
> = {
  positive: {
    label: "Positive",
    badge: "bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800",
    dot: "bg-emerald-500",
    text: "text-emerald-600 dark:text-emerald-400",
    bg: "bg-emerald-500",
    hex: "#10b981",
  },
  negative: {
    label: "Negative",
    badge: "bg-rose-100 text-rose-800 border-rose-300 dark:bg-rose-950 dark:text-rose-300 dark:border-rose-800",
    dot: "bg-rose-500",
    text: "text-rose-600 dark:text-rose-400",
    bg: "bg-rose-500",
    hex: "#f43f5e",
  },
  neutral: {
    label: "Neutral",
    badge: "bg-zinc-100 text-zinc-700 border-zinc-300 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-600",
    dot: "bg-zinc-400",
    text: "text-zinc-600 dark:text-zinc-400",
    bg: "bg-zinc-400",
    hex: "#a1a1aa",
  },
  mixed: {
    label: "Mixed",
    badge: "bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800",
    dot: "bg-amber-500",
    text: "text-amber-600 dark:text-amber-400",
    bg: "bg-amber-500",
    hex: "#f59e0b",
  },
};
