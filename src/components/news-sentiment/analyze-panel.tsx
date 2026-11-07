"use client";

import * as React from "react";
import { toast } from "sonner";
import { motion } from "framer-motion";
import {
  Cpu,
  GraduationCap,
  Loader2,
  Newspaper,
  Quote,
  ScanSearch,
  Sparkles,
  Tag,
  Timer,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { SENTIMENT_META } from "@/lib/types";
import type {
  AnalyzeStreamEvent,
  ModelInfo,
  StructuredAnalysis,
} from "@/lib/types";
import { fetchJSON, postSSE } from "@/lib/sse-client";
import { SAMPLE_NEWS, type SampleNews } from "@/lib/sample-news";
import { SentimentGauge } from "./sentiment-gauge";

interface AnalyzePanelProps {
  /** Called after an analysis is successfully saved (done event) so other tabs can refresh. */
  onSaved?: () => void;
}

const FALLBACK_MODELS = [
  { id: "edge0-35b", label: "Edge0-35B — deeper reasoning" },
  { id: "edge0-8b", label: "Edge0-8B — faster" },
];

const MODEL_LABELS: Record<string, string> = {
  "edge0-35b": "Edge0-35B — deeper reasoning",
  "edge0-8b": "Edge0-8B — faster",
};

type AnalysisEvent = Extract<AnalyzeStreamEvent, { event: "analysis" }>["data"];
type DeltaEvent = Extract<AnalyzeStreamEvent, { event: "delta" }>["data"];
type DoneEvent = Extract<AnalyzeStreamEvent, { event: "done" }>["data"];
type ErrorEvent = Extract<AnalyzeStreamEvent, { event: "error" }>["data"];

function formatLatency(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

export function AnalyzePanel({ onSaved }: AnalyzePanelProps) {
  const [title, setTitle] = React.useState("");
  const [source, setSource] = React.useState("");
  const [text, setText] = React.useState("");
  const [model, setModel] = React.useState("edge0-35b");
  const [modelOptions, setModelOptions] = React.useState(FALLBACK_MODELS);

  const [phase, setPhase] = React.useState<"idle" | "running">("idle");
  const [analysis, setAnalysis] = React.useState<StructuredAnalysis | null>(null);
  const [resultMeta, setResultMeta] = React.useState<{ latencyMs: number; model: string } | null>(null);
  const [explanation, setExplanation] = React.useState("");
  const [streamingTutor, setStreamingTutor] = React.useState(false);
  const abortRef = React.useRef<AbortController | null>(null);

  // Pick up the live model list from the API (fall back to the constant list).
  React.useEffect(() => {
    let cancelled = false;
    fetchJSON<{ ok: boolean; models: ModelInfo[] }>("/api/models")
      .then((res) => {
        if (cancelled || !Array.isArray(res.models) || res.models.length === 0) return;
        setModelOptions(
          res.models.map((m) => ({ id: m.id, label: MODEL_LABELS[m.id] ?? m.id }))
        );
      })
      .catch(() => {
        /* header badge shows API status; the picker just keeps fallbacks */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Abort any in-flight stream when unmounting.
  React.useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  function loadSample(sample: SampleNews) {
    setTitle(sample.title);
    setSource(sample.source);
    setText(sample.text);
  }

  function resetResult() {
    setAnalysis(null);
    setResultMeta(null);
    setExplanation("");
    setStreamingTutor(false);
  }

  async function runAnalysis() {
    const trimmed = text.trim();
    if (trimmed.length < 20 || phase === "running") return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setPhase("running");
    resetResult();
    setStreamingTutor(true);

    let streamErrorMessage: string | null = null;

    try {
      await postSSE(
        "/api/analyze",
        {
          text: trimmed,
          title: title.trim() || undefined,
          source: source.trim() || undefined,
          model,
        },
        {
          signal: controller.signal,
          onEvent: (event, data) => {
            if (event === "analysis") {
              const d = data as AnalysisEvent;
              setAnalysis(d.analysis);
              setResultMeta({ latencyMs: d.latencyMs, model: d.model });
            } else if (event === "delta") {
              const d = data as DeltaEvent;
              setExplanation((prev) => prev + d.t);
            } else if (event === "done") {
              setStreamingTutor(false);
              toast.success("Analysis saved to history");
              onSaved?.();
            } else if (event === "error") {
              const d = data as ErrorEvent;
              streamErrorMessage = d.message;
            }
          },
        }
      );
      if (streamErrorMessage) throw new Error(streamErrorMessage);
      setStreamingTutor(false);
    } catch (err) {
      setStreamingTutor(false);
      if (!controller.signal.aborted) {
        toast.error("Analysis failed", {
          description: err instanceof Error ? err.message : "Unknown error",
        });
      }
      setPhase("idle");
      resetResult();
      return;
    }
    setPhase("idle");
  }

  function cancelAnalysis() {
    abortRef.current?.abort();
  }

  const canAnalyze = text.trim().length >= 20 && phase === "idle";
  const meta = analysis ? SENTIMENT_META[analysis.sentiment] : null;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* LEFT — input */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Newspaper className="size-4 text-amber-600 dark:text-amber-400" />
            News article
          </CardTitle>
          <CardDescription>
            Paste an article and let an Edge0 edge model grade its sentiment from -1 to +1.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Headline (optional)"
            aria-label="Headline"
          />
          <Input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="Source (optional, e.g. Reuters)"
            aria-label="Source"
          />

          <div className="relative">
            <Textarea
              rows={8}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Paste the news article text here… (min 20 characters)"
              aria-label="Article text"
              className="resize-none"
            />
            <span className="pointer-events-none absolute bottom-2.5 right-3 text-xs tabular-nums text-muted-foreground">
              {text.length} chars
            </span>
          </div>

          <div>
            <label htmlFor="model-select" className="text-xs font-medium text-muted-foreground">
              Model
            </label>
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger id="model-select" className="mt-1.5 w-full">
                <SelectValue placeholder="Choose a model" />
              </SelectTrigger>
              <SelectContent>
                {modelOptions.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Try a sample:</span>
            {SAMPLE_NEWS.map((s) => (
              <Button
                key={s.label}
                variant="outline"
                size="sm"
                className="h-7 rounded-full px-3 text-xs"
                onClick={() => loadSample(s)}
              >
                {s.label}
              </Button>
            ))}
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              className="w-full sm:w-auto"
              onClick={() => void runAnalysis()}
              disabled={!canAnalyze}
            >
              {phase === "running" ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <Sparkles aria-hidden />
              )}
              {phase === "running" ? `Analyzing with ${model}…` : "Analyze sentiment"}
            </Button>
            {phase === "running" && (
              <Button variant="ghost" onClick={cancelAnalysis}>
                <X aria-hidden />
                Cancel
              </Button>
            )}
          </div>
          {text.trim().length < 20 && (
            <p className="text-xs text-muted-foreground">
              At least 20 characters are required ({text.trim().length}/20).
            </p>
          )}
        </CardContent>
      </Card>

      {/* RIGHT — result area */}
      <div className="space-y-4">
        {phase === "running" && !analysis && (
          <Card>
            <CardContent className="space-y-3 pt-2">
              <div className="flex items-center justify-between">
                <span className="animate-pulse text-sm font-medium text-muted-foreground">
                  Contacting edge0 model…
                </span>
                <div className="flex items-center gap-1.5" aria-hidden>
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className="size-1.5 animate-bounce rounded-full bg-zinc-400 dark:bg-zinc-500"
                      style={{ animationDelay: `${i * 150}ms` }}
                    />
                  ))}
                </div>
              </div>
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-24 w-full rounded-lg" />
            </CardContent>
          </Card>
        )}

        {phase === "idle" && !analysis && (
          <div className="flex min-h-[320px] flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-8 text-center">
            <div className="flex size-14 items-center justify-center rounded-full bg-muted">
              <ScanSearch className="size-6 text-muted-foreground" aria-hidden />
            </div>
            <p className="font-medium">No analysis yet</p>
            <p className="max-w-xs text-sm text-muted-foreground">
              Paste an article or pick a sample, then hit Analyze.
            </p>
          </div>
        )}

        {analysis && meta && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: "easeOut" }}
            className="space-y-4"
          >
            <Card>
              <CardContent className="space-y-5 pt-2">
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge className={meta.badge}>{meta.label}</Badge>
                    <Badge variant="outline" className="gap-1">
                      <Cpu aria-hidden />
                      {resultMeta?.model ?? model}
                    </Badge>
                    {resultMeta && (
                      <Badge variant="outline" className="gap-1">
                        <Timer aria-hidden />
                        {formatLatency(resultMeta.latencyMs)}
                      </Badge>
                    )}
                  </div>
                  {analysis.title && (
                    <h3 className="text-lg font-semibold leading-snug">{analysis.title}</h3>
                  )}
                  {source.trim() && (
                    <p className="text-xs text-muted-foreground">Source: {source.trim()}</p>
                  )}
                </div>

                <div className="flex justify-center py-1">
                  <SentimentGauge score={analysis.score} sentiment={analysis.sentiment} />
                </div>

                <div>
                  <div className="mb-1.5 flex items-center justify-between text-sm">
                    <span className="font-medium">Confidence</span>
                    <span className="tabular-nums text-muted-foreground">
                      {Math.round(analysis.confidence * 100)}%
                    </span>
                  </div>
                  <Progress value={Math.round(analysis.confidence * 100)} aria-label="Confidence" />
                </div>

                {analysis.summary && (
                  <div className="flex gap-2.5 rounded-lg bg-muted/60 p-3 dark:bg-muted/40">
                    <Quote className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <p className="text-sm italic leading-relaxed">{analysis.summary}</p>
                  </div>
                )}

                {analysis.emotions.length > 0 && (
                  <div>
                    <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Emotions
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {analysis.emotions.map((e) => (
                        <Badge key={e.name} variant="outline" className="gap-1.5 font-normal">
                          <span
                            className="size-1.5 rounded-full bg-zinc-900 dark:bg-zinc-100"
                            style={{ opacity: 0.3 + Math.max(0, Math.min(1, e.intensity)) * 0.7 }}
                            aria-hidden
                          />
                          {e.name}
                          <span className="tabular-nums text-muted-foreground">
                            {Math.max(0, Math.min(1, e.intensity)).toFixed(1)}
                          </span>
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {analysis.keywords.length > 0 && (
                  <div>
                    <p className="mb-1.5 flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      <Tag className="size-3" aria-hidden />
                      Keywords
                    </p>
                    <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
                      {analysis.keywords.map((k, i) => (
                        <span
                          key={`${k.term}-${i}`}
                          className="font-medium text-foreground"
                          style={{
                            fontSize: 11 + Math.max(0, Math.min(1, k.relevance)) * 5,
                            opacity: 0.55 + Math.max(0, Math.min(1, k.relevance)) * 0.45,
                          }}
                        >
                          {k.term}
                          {i < analysis.keywords.length - 1 ? "," : ""}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {analysis.entities.length > 0 && (
                  <div>
                    <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Entities
                    </p>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {analysis.entities.map((e, i) => {
                        const impact = (e.impact ?? "").toLowerCase();
                        const dot =
                          impact === "positive"
                            ? "bg-emerald-500"
                            : impact === "negative"
                              ? "bg-rose-500"
                              : impact === "mixed"
                                ? "bg-amber-500"
                                : "bg-zinc-400";
                        return (
                          <div key={`${e.name}-${i}`} className="rounded-lg border p-2.5">
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate text-sm font-medium">{e.name}</span>
                              <Badge
                                variant="secondary"
                                className="text-[10px] uppercase tracking-wide"
                              >
                                {e.type}
                              </Badge>
                            </div>
                            <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                              <span className={`size-1.5 rounded-full ${dot}`} aria-hidden />
                              <span className="capitalize">{impact || "neutral"} impact</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* AI tutor streamed explanation */}
            <div className="rounded-xl border bg-muted/40 p-4 dark:bg-muted/30">
              <div className="flex items-center gap-2">
                <GraduationCap className="size-4 text-amber-600 dark:text-amber-400" aria-hidden />
                <span className="text-sm font-semibold">AI tutor explanation</span>
                {streamingTutor && (
                  <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="relative flex size-2" aria-hidden>
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                      <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
                    </span>
                    streaming
                  </span>
                )}
              </div>
              <div className="mt-2 min-h-16 whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
                {explanation}
                {streamingTutor && (
                  <span className="animate-pulse" aria-hidden>
                    ▍
                  </span>
                )}
                {streamingTutor && !explanation && (
                  <span className="text-muted-foreground">Warming up the tutor…</span>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </div>
    </div>
  );
}
