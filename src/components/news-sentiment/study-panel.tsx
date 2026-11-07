"use client";

import * as React from "react";
import { toast } from "sonner";
import { AnimatePresence, motion } from "framer-motion";
import {
  BookOpen,
  CheckCircle2,
  Flame,
  GraduationCap,
  Hash,
  Minus,
  Shuffle,
  Target,
  TrendingDown,
  TrendingUp,
  Trophy,
  Wand2,
  XCircle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { SENTIMENT_META } from "@/lib/types";
import type { QuizStatsResponse, SentimentLabel } from "@/lib/types";
import { fetchJSON } from "@/lib/sse-client";

interface QuizRound {
  id: string;
  headline: string;
  body: string;
}

interface QuizAnswerResponse {
  ok: boolean;
  aiSentiment: SentimentLabel;
  correct: boolean;
  explanation: string;
}

const GUESSES: { value: SentimentLabel; label: string; icon: LucideIcon }[] = [
  { value: "positive", label: "Positive", icon: TrendingUp },
  { value: "negative", label: "Negative", icon: TrendingDown },
  { value: "neutral", label: "Neutral", icon: Minus },
  { value: "mixed", label: "Mixed", icon: Shuffle },
];

const LEARNING_ITEMS: { title: string; content: string }[] = [
  {
    title: "What is sentiment analysis?",
    content:
      "Sentiment analysis is an NLP task that classifies the subjective tone of a text — is it positive, negative, or neutral? In this lab we go a step further and grade news articles on a continuous scale from -1 (very negative) to +1 (very positive), so subtle leanings are visible instead of being flattened into three buckets.",
  },
  {
    title: "Polarity vs subjectivity",
    content:
      "Polarity is the direction of feeling: positive or negative. Subjectivity is whether the text expresses opinion or fact. A factual report can still be negative (\"revenue fell 40%\"), and neutral does not necessarily mean objective — a neutral-toned article may simply be withholding judgment.",
  },
  {
    title: "Lexicon vs ML vs LLM approaches",
    content:
      "Lexicon methods (like VADER) score words from curated lists — fast and interpretable, but blind to context. Trained classifiers learn patterns from labeled data and work well in-domain, but need annotations. LLMs prompt with the raw text and reason zero-shot, handling nuance, negation, and domain shift — at the cost of higher latency and less predictable calibration.",
  },
  {
    title: "Fine-grained scores",
    content:
      "A continuous -1..1 score carries more information than three classes: \"+0.8\" and \"+0.3\" are both positive but clearly different in strength. You can always recover classes by thresholding — e.g. score > 0.33 → positive, score < -0.33 → negative, otherwise neutral — while keeping intensity for ranking and dashboards.",
  },
  {
    title: "The tricky cases",
    content:
      "Sarcasm (\"What a great quarter — losses doubled!\") flips surface words against true meaning. Negation inverts polarity (\"not good\" ≠ good). Mixed coverage balances good and bad news about the same subject, and forward-looking hedging (\"could fall\", \"may recover\") tempers claims. These are exactly where simple lexicons fail and stronger models earn their keep.",
  },
  {
    title: "How this lab analyzes",
    content:
      "Each analysis runs a two-phase pipeline on an Edge0 edge model. First, the model returns a structured JSON verdict — sentiment, score, confidence, emotions, keywords, and entities. Second, it streams an AI tutor explanation token by token, teaching you why the verdict was reached. Every run is saved so you can study patterns in the dashboard.",
  },
];

export function StudyPanel() {
  const [quizStats, setQuizStats] = React.useState<QuizStatsResponse | null>(null);
  const [round, setRound] = React.useState<QuizRound | null>(null);
  const [roundLoading, setRoundLoading] = React.useState(false);
  const [guess, setGuess] = React.useState<SentimentLabel | null>(null);
  const [result, setResult] = React.useState<QuizAnswerResponse | null>(null);
  const [answering, setAnswering] = React.useState(false);

  const fetchQuizStats = React.useCallback(async () => {
    try {
      const res = await fetchJSON<QuizStatsResponse>("/api/quiz/stats");
      setQuizStats(res);
    } catch {
      /* stats are non-critical; ignore */
    }
  }, []);

  React.useEffect(() => {
    void fetchQuizStats();
  }, [fetchQuizStats]);

  async function nextRound() {
    setRoundLoading(true);
    setResult(null);
    setGuess(null);
    try {
      const res = await fetchJSON<{ ok: boolean; round: QuizRound }>("/api/quiz/next", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "edge0-8b" }),
      });
      setRound(res.round);
    } catch (err) {
      toast.error("Could not generate a headline", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setRoundLoading(false);
    }
  }

  async function submitGuess(g: SentimentLabel) {
    if (!round || result || answering) return;
    setGuess(g);
    setAnswering(true);
    try {
      const res = await fetchJSON<QuizAnswerResponse>("/api/quiz/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roundId: round.id, guess: g }),
      });
      setResult(res);
      void fetchQuizStats();
    } catch (err) {
      toast.error("Could not check your answer", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
      setGuess(null);
    } finally {
      setAnswering(false);
    }
  }

  function buttonStateCls(g: SentimentLabel): string {
    if (!result || !guess) return "";
    if (g === guess && result.correct) {
      return "border-emerald-500 bg-emerald-50 ring-2 ring-emerald-500 dark:bg-emerald-950/40";
    }
    if (g === guess && !result.correct) {
      return "border-rose-500 bg-rose-50 ring-2 ring-rose-500 dark:bg-rose-950/40";
    }
    if (g === result.aiSentiment) {
      return "border-emerald-500 ring-2 ring-emerald-500";
    }
    return "opacity-50";
  }

  const accuracy =
    quizStats && quizStats.total > 0 ? `${Math.round((quizStats.accuracy ?? 0) * 100)}%` : "—";

  const miniStats = [
    { label: "Accuracy", value: accuracy, icon: Target, iconCls: "text-amber-600 dark:text-amber-400" },
    { label: "Streak", value: quizStats ? String(quizStats.streak ?? 0) : "—", icon: Flame, iconCls: "text-amber-600 dark:text-amber-400" },
    { label: "Best streak", value: quizStats ? String(quizStats.bestStreak ?? 0) : "—", icon: Trophy, iconCls: "text-amber-600 dark:text-amber-400" },
    { label: "Rounds played", value: quizStats ? String(quizStats.total ?? 0) : "—", icon: Hash, iconCls: "text-muted-foreground" },
  ];

  return (
    <div className="grid gap-6 lg:grid-cols-5">
      {/* LEFT — learning material */}
      <Card className="gap-4 lg:col-span-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BookOpen className="size-4 text-amber-600 dark:text-amber-400" aria-hidden />
            Sentiment analysis 101
          </CardTitle>
          <CardDescription>The essentials, in six short lessons.</CardDescription>
        </CardHeader>
        <CardContent>
          <Accordion type="single" collapsible className="w-full">
            {LEARNING_ITEMS.map((item, i) => (
              <AccordionItem key={item.title} value={`lesson-${i}`}>
                <AccordionTrigger className="text-sm">
                  <span className="flex items-center gap-2 pr-2 text-left">
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">
                      {i + 1}
                    </span>
                    {item.title}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-sm leading-relaxed text-muted-foreground">
                  {item.content}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </CardContent>
      </Card>

      {/* RIGHT — guess-the-sentiment game */}
      <Card className="gap-4 lg:col-span-3">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <GraduationCap className="size-4 text-amber-600 dark:text-amber-400" aria-hidden />
            Guess the sentiment
          </CardTitle>
          <CardDescription>
            Read a real headline, call its sentiment, and see how the AI graded it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Stats row */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {miniStats.map((s) => (
              <div key={s.label} className="rounded-lg border p-2.5">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <s.icon className={`size-3.5 ${s.iconCls}`} aria-hidden />
                  {s.label}
                </div>
                <p className="mt-0.5 text-lg font-bold tabular-nums">{s.value}</p>
              </div>
            ))}
          </div>

          {/* Game area */}
          <AnimatePresence mode="wait" initial={false}>
            {roundLoading && (
              <motion.div
                key="loading"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.2 }}
                className="space-y-3"
                aria-busy="true"
              >
                <Skeleton className="h-6 w-3/4" />
                <Skeleton className="h-16 w-full rounded-lg" />
                <div className="grid grid-cols-2 gap-3">
                  {[0, 1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-12 rounded-md" />
                  ))}
                </div>
              </motion.div>
            )}

            {!roundLoading && !round && (
              <motion.div
                key="idle"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.2 }}
                className="flex min-h-56 flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed p-6 text-center"
              >
                <div className="flex size-14 items-center justify-center rounded-full bg-muted">
                  <Wand2 className="size-6 text-muted-foreground" aria-hidden />
                </div>
                <p className="max-w-xs text-sm text-muted-foreground">
                  Generate a practice headline and test your sentiment instincts against the AI.
                </p>
                <Button onClick={() => void nextRound()}>
                  <Wand2 aria-hidden />
                  Generate a practice headline
                </Button>
              </motion.div>
            )}

            {!roundLoading && round && (
              <motion.div
                key={round.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.2 }}
                className="space-y-4"
              >
                <div>
                  <h3 className="text-lg font-semibold leading-snug">{round.headline}</h3>
                  <p className="mt-2 max-h-40 overflow-y-auto text-sm leading-relaxed text-muted-foreground custom-scrollbar pr-1">
                    {round.body}
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  {GUESSES.map((g) => {
                    const Icon = g.icon;
                    return (
                      <Button
                        key={g.value}
                        variant="outline"
                        className={`h-12 justify-center gap-2 transition-shadow ${buttonStateCls(g.value)}`}
                        disabled={answering || !!result}
                        onClick={() => void submitGuess(g.value)}
                        aria-pressed={guess === g.value}
                      >
                        <span
                          className={`size-2 rounded-full ${SENTIMENT_META[g.value].dot}`}
                          aria-hidden
                        />
                        <Icon className="size-4" aria-hidden />
                        {g.label}
                      </Button>
                    );
                  })}
                </div>

                {answering && (
                  <p className="animate-pulse text-sm text-muted-foreground">Checking your guess…</p>
                )}

                {result && (
                  <motion.div
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.25 }}
                    className="space-y-3 rounded-xl border bg-muted/40 p-4 dark:bg-muted/30"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      {result.correct ? (
                        <CheckCircle2 className="size-5 text-emerald-500" aria-hidden />
                      ) : (
                        <XCircle className="size-5 text-rose-500" aria-hidden />
                      )}
                      <span className="text-sm font-semibold">
                        {result.correct ? "Correct!" : "Not quite"}
                      </span>
                      <Badge className={SENTIMENT_META[result.aiSentiment]?.badge ?? SENTIMENT_META.neutral.badge}>
                        AI says: {SENTIMENT_META[result.aiSentiment]?.label ?? result.aiSentiment}
                      </Badge>
                    </div>
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      {result.explanation}
                    </p>
                    <Button variant="outline" onClick={() => void nextRound()} disabled={roundLoading}>
                      <Wand2 aria-hidden />
                      Next headline
                    </Button>
                  </motion.div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </CardContent>
      </Card>
    </div>
  );
}
