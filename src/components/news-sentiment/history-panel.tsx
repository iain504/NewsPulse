"use client";

import * as React from "react";
import { toast } from "sonner";
import { format, formatDistanceToNow } from "date-fns";
import { Cpu, History, Loader2, Quote, RefreshCw, Timer, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { SENTIMENT_META } from "@/lib/types";
import type { AnalysisRow, SentimentLabel } from "@/lib/types";
import { fetchJSON } from "@/lib/sse-client";

type SentimentFilter = "all" | SentimentLabel;

interface HistoryPanelProps {
  /** Incremented by the page whenever a new analysis is saved, triggering a re-fetch. */
  refreshKey?: number;
}

interface ParsedEmotion {
  name: string;
  intensity: number;
}

interface ParsedKeyword {
  term: string;
  relevance: number;
}

interface ParsedEntity {
  name: string;
  type?: string;
  impact?: string;
}

function impactDotCls(impact?: string): string {
  switch (impact) {
    case "positive":
      return "bg-emerald-500";
    case "negative":
      return "bg-rose-500";
    default:
      return "bg-zinc-400";
  }
}

const SENTIMENT_ORDER: SentimentLabel[] = ["positive", "negative", "neutral", "mixed"];

function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function formatSigned(v: number): string {
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}`;
}

function scoreColorCls(v: number): string {
  if (v > 0.005) return "text-emerald-600 dark:text-emerald-400";
  if (v < -0.005) return "text-rose-600 dark:text-rose-400";
  return "text-zinc-600 dark:text-zinc-400";
}

function formatLatency(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function timeAgo(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return "";
  }
}

function fullDate(iso: string): string {
  try {
    return format(new Date(iso), "PPP 'at' p");
  } catch {
    return "";
  }
}

export function HistoryPanel({ refreshKey = 0 }: HistoryPanelProps) {
  const [rows, setRows] = React.useState<AnalysisRow[]>([]);
  const [filter, setFilter] = React.useState<SentimentFilter>("all");
  const [loading, setLoading] = React.useState(true);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<AnalysisRow | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);

  const load = React.useCallback(async (currentFilter: SentimentFilter) => {
    setLoading(true);
    try {
      const res = await fetchJSON<{ ok: boolean; analyses: AnalysisRow[] }>(
        `/api/analyses?limit=100&sentiment=${currentFilter}`
      );
      setRows(Array.isArray(res.analyses) ? res.analyses : []);
    } catch (err) {
      toast.error("Failed to load history", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load(filter);
  }, [load, filter, refreshKey]);

  async function remove(id: string) {
    setDeletingId(id);
    try {
      await fetchJSON<{ ok: boolean }>(`/api/analyses?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      setRows((prev) => prev.filter((r) => r.id !== id));
      toast.success("Analysis deleted");
    } catch (err) {
      toast.error("Could not delete analysis", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setDeletingId(null);
    }
  }

  function openDetail(row: AnalysisRow) {
    setDetail(row);
    setDialogOpen(true);
  }

  return (
    <Card className="gap-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 px-6 pt-6">
        <h2 className="text-base font-semibold">
          Analysis history
          <Badge variant="secondary" className="ml-2 tabular-nums">
            {rows.length}
          </Badge>
        </h2>
        <div className="ml-auto flex items-center gap-2">
          <Select value={filter} onValueChange={(v) => setFilter(v as SentimentFilter)}>
            <SelectTrigger className="w-40" aria-label="Filter by sentiment">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sentiments</SelectItem>
              {SENTIMENT_ORDER.map((s) => (
                <SelectItem key={s} value={s}>
                  <span className="flex items-center gap-2">
                    <span className={`size-2 rounded-full ${SENTIMENT_META[s].dot}`} aria-hidden />
                    {SENTIMENT_META[s].label}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="icon"
            aria-label="Refresh history"
            onClick={() => void load(filter)}
            disabled={loading}
          >
            <RefreshCw className={loading ? "animate-spin" : undefined} aria-hidden />
          </Button>
        </div>
      </div>

      <CardContent className="px-6 pb-6">
        {loading && rows.length === 0 ? (
          <div className="space-y-3" aria-busy="true">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-28 rounded-xl" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="flex min-h-56 flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-8 text-center">
            <div className="flex size-14 items-center justify-center rounded-full bg-muted">
              <History className="size-6 text-muted-foreground" aria-hidden />
            </div>
            <p className="font-medium">Nothing here yet</p>
            <p className="max-w-xs text-sm text-muted-foreground">
              {filter === "all"
                ? "Run an analysis in the Analyze tab and it will appear in this history."
                : `No ${SENTIMENT_META[filter as SentimentLabel].label.toLowerCase()} analyses saved yet — try another filter.`}
            </p>
          </div>
        ) : (
          <ul className="max-h-[32rem] space-y-3 overflow-y-auto pr-1 custom-scrollbar">
            {rows.map((row) => {
              const meta = SENTIMENT_META[row.sentiment] ?? SENTIMENT_META.neutral;
              return (
                <li key={row.id}>
                  <Card
                    className="cursor-pointer gap-0 py-4 transition-colors hover:border-zinc-300 dark:hover:border-zinc-700"
                    role="button"
                    tabIndex={0}
                    onClick={() => openDetail(row)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openDetail(row);
                      }
                    }}
                  >
                    <CardContent className="space-y-2 px-4">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge className={meta.badge}>{meta.label}</Badge>
                            <span
                              className={`text-sm font-bold tabular-nums ${scoreColorCls(row.score ?? 0)}`}
                            >
                              {formatSigned(row.score ?? 0)}
                            </span>
                          </div>
                          <h4 className="mt-1.5 leading-snug font-medium">
                            {row.title || "Untitled analysis"}
                          </h4>
                          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                            {row.summary}
                          </p>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8 shrink-0 text-muted-foreground hover:text-rose-600 dark:hover:text-rose-400"
                          aria-label={`Delete analysis: ${row.title || "untitled"}`}
                          disabled={deletingId === row.id}
                          onClick={(e) => {
                            e.stopPropagation();
                            void remove(row.id);
                          }}
                        >
                          {deletingId === row.id ? (
                            <Loader2 className="animate-spin" aria-hidden />
                          ) : (
                            <Trash2 aria-hidden />
                          )}
                        </Button>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <Badge variant="outline" className="gap-1">
                          <Cpu aria-hidden />
                          {row.model}
                        </Badge>
                        <span className="flex items-center gap-1">
                          <Timer className="size-3" aria-hidden />
                          {formatLatency(row.latencyMs ?? 0)}
                        </span>
                        <span>{timeAgo(row.createdAt)}</span>
                      </div>
                    </CardContent>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>

      {/* Detail dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto custom-scrollbar sm:max-w-lg">
          {detail && (
            <div className="space-y-4">
              <DialogHeader>
                <DialogTitle className="pr-6 leading-snug">
                  {detail.title || "Untitled analysis"}
                </DialogTitle>
                <DialogDescription>
                  {detail.source ? `${detail.source} · ` : ""}
                  {detail.createdAt ? fullDate(detail.createdAt) : ""}
                </DialogDescription>
              </DialogHeader>

              <div className="flex flex-wrap items-center gap-2">
                <Badge className={(SENTIMENT_META[detail.sentiment] ?? SENTIMENT_META.neutral).badge}>
                  {(SENTIMENT_META[detail.sentiment] ?? SENTIMENT_META.neutral).label}
                </Badge>
                <span
                  className={`text-lg font-bold tabular-nums ${scoreColorCls(detail.score ?? 0)}`}
                >
                  {formatSigned(detail.score ?? 0)}
                </span>
                <Badge variant="outline" className="gap-1">
                  <Cpu aria-hidden />
                  {detail.model}
                </Badge>
                <Badge variant="outline" className="gap-1">
                  <Timer aria-hidden />
                  {formatLatency(detail.latencyMs ?? 0)}
                </Badge>
              </div>

              <div>
                <div className="mb-1.5 flex items-center justify-between text-sm">
                  <span className="font-medium">Confidence</span>
                  <span className="tabular-nums text-muted-foreground">
                    {Math.round((detail.confidence ?? 0) * 100)}%
                  </span>
                </div>
                <Progress
                  value={Math.round((detail.confidence ?? 0) * 100)}
                  aria-label="Confidence"
                />
              </div>

              {detail.summary && (
                <div className="flex gap-2.5 rounded-lg bg-muted/60 p-3 dark:bg-muted/40">
                  <Quote className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <p className="text-sm italic leading-relaxed">{detail.summary}</p>
                </div>
              )}

              {(() => {
                const emotions = parseJsonArray<ParsedEmotion>(detail.emotions);
                if (emotions.length === 0) return null;
                return (
                  <div>
                    <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Emotions
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {emotions.map((e, i) => (
                        <Badge key={`${e.name}-${i}`} variant="outline" className="gap-1.5 font-normal">
                          <span
                            className="size-1.5 rounded-full bg-zinc-900 dark:bg-zinc-100"
                            style={{
                              opacity: 0.3 + Math.max(0, Math.min(1, e.intensity ?? 0)) * 0.7,
                            }}
                            aria-hidden
                          />
                          {e.name}
                          <span className="tabular-nums text-muted-foreground">
                            {Math.max(0, Math.min(1, e.intensity ?? 0)).toFixed(1)}
                          </span>
                        </Badge>
                      ))}
                    </div>
                  </div>
                );
              })()}

              {(() => {
                const keywords = parseJsonArray<ParsedKeyword>(detail.keywords);
                if (keywords.length === 0) return null;
                return (
                  <div>
                    <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Keywords
                    </p>
                    <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
                      {keywords.map((k, i) => (
                        <span
                          key={`${k.term}-${i}`}
                          className="font-medium text-foreground"
                          style={{
                            fontSize: 11 + Math.max(0, Math.min(1, k.relevance ?? 0)) * 5,
                            opacity: 0.55 + Math.max(0, Math.min(1, k.relevance ?? 0)) * 0.45,
                          }}
                        >
                          {k.term}
                          {i < keywords.length - 1 ? "," : ""}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })()}

              {(() => {
                const entities = parseJsonArray<ParsedEntity>(detail.entities);
                if (entities.length === 0) return null;
                return (
                  <div>
                    <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Entities
                    </p>
                    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                      {entities.map((e, i) => (
                        <div
                          key={`${e.name}-${i}`}
                          className="flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5"
                        >
                          <span className="min-w-0 truncate text-sm font-medium">{e.name}</span>
                          <span className="flex shrink-0 items-center gap-1.5">
                            {e.type && (
                              <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-normal">
                                {e.type}
                              </Badge>
                            )}
                            <span
                              className={`size-2 rounded-full ${impactDotCls(e.impact)}`}
                              aria-label={`impact: ${e.impact ?? "neutral"}`}
                            />
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

