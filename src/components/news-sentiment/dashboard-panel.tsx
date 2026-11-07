"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { format, formatDistanceToNow } from "date-fns";
import { BarChart3, Cpu, FileText, Gauge, RefreshCw, ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { SENTIMENT_META } from "@/lib/types";
import type { SentimentLabel, StatsResponse } from "@/lib/types";
import { fetchJSON } from "@/lib/sse-client";

const SENTIMENT_ORDER: SentimentLabel[] = ["positive", "negative", "neutral", "mixed"];

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

/**
 * The stats API returns daily dates in a compact "MM-DD" form (plus it may
 * return full ISO strings). Parse defensively and never throw — fall back to
 * the raw string as the axis label when unparseable.
 */
function dailyLabel(raw: string): string {
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (ymd) {
    return format(new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])), "MMM d");
  }
  const md = /^(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (md) {
    return format(new Date(new Date().getFullYear(), Number(md[1]) - 1, Number(md[2])), "MMM d");
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? raw : format(parsed, "MMM d");
}

const AXIS_TICK_CLS = "[&_text]:fill-zinc-500 dark:[&_text]:fill-zinc-400";

const tooltipContentStyle: React.CSSProperties = {
  backgroundColor: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  fontSize: 12,
  color: "var(--popover-foreground)",
};

export function DashboardPanel() {
  const [stats, setStats] = React.useState<StatsResponse | null>(null);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchJSON<StatsResponse>("/api/stats");
      setStats(res);
    } catch (err) {
      toast.error("Failed to load stats", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  if (loading && !stats) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <div className="grid gap-6 lg:grid-cols-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-72 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  if (!stats || stats.total === 0) {
    return (
      <div className="flex min-h-[320px] flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-8 text-center">
        <div className="flex size-14 items-center justify-center rounded-full bg-muted">
          <BarChart3 className="size-6 text-muted-foreground" aria-hidden />
        </div>
        <p className="font-medium">No data yet — analyze some news first</p>
        <p className="max-w-xs text-sm text-muted-foreground">
          Head over to the Analyze tab, run a sentiment analysis, and your stats will appear here.
        </p>
      </div>
    );
  }

  const pieData = SENTIMENT_ORDER.map((key) => ({
    key,
    name: SENTIMENT_META[key].label,
    value: stats.bySentiment?.[key] ?? 0,
  })).filter((d) => d.value > 0);
  const pieTotal = pieData.reduce((acc, d) => acc + d.value, 0);

  const dailyData = (stats.daily ?? []).map((d) => ({
    date: dailyLabel(d.date ?? ""),
    avgScore: Math.round((d.avgScore ?? 0) * 100) / 100,
  }));

  const keywordData = (stats.topKeywords ?? []).slice(0, 8);

  const modelRows = [...(stats.models ?? [])].sort((a, b) => b.count - a.count);

  return (
    <section className="space-y-6" aria-label="Sentiment dashboard">
      {/* Header + refresh */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Sentiment overview</h2>
          <p className="text-sm text-muted-foreground">
            Aggregated results across every saved analysis.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={loading ? "animate-spin" : undefined} aria-hidden />
          Refresh
        </Button>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[
          {
            label: "Total analyses",
            value: String(stats.total),
            icon: FileText,
            valueCls: "",
          },
          {
            label: "Avg sentiment score",
            value: formatSigned(stats.avgScore ?? 0),
            icon: Gauge,
            valueCls: scoreColorCls(stats.avgScore ?? 0),
          },
          {
            label: "Avg confidence",
            value: `${Math.round((stats.avgConfidence ?? 0) * 100)}%`,
            icon: ShieldCheck,
            valueCls: "",
          },
          {
            label: "Models used",
            value: String(stats.models?.length ?? 0),
            icon: Cpu,
            valueCls: "",
          },
        ].map((card) => (
          <Card key={card.label} className="relative gap-1 py-4">
            <CardContent className="px-4">
              <card.icon
                className="absolute right-3 top-3 size-4 text-muted-foreground/60"
                aria-hidden
              />
              <p className="text-xs text-muted-foreground">{card.label}</p>
              <p className={`mt-1 text-2xl font-bold tabular-nums ${card.valueCls}`}>
                {card.value}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Charts */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* 1. Sentiment distribution donut */}
        <Card className="gap-4">
          <CardHeader>
            <CardTitle className="text-base">Sentiment distribution</CardTitle>
          </CardHeader>
          <CardContent>
            {pieData.length === 0 ? (
              <div className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">
                No sentiment data yet
              </div>
            ) : (
              <>
                <div className="relative">
                  <ResponsiveContainer width="100%" height={260}>
                    <PieChart>
                      <Pie
                        data={pieData}
                        dataKey="value"
                        nameKey="name"
                        innerRadius={55}
                        outerRadius={85}
                        paddingAngle={2}
                        stroke="var(--background)"
                        strokeWidth={2}
                      >
                        {pieData.map((d) => (
                          <Cell key={d.key} fill={SENTIMENT_META[d.key].hex} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={tooltipContentStyle} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-2xl font-bold tabular-nums">{pieTotal}</span>
                    <span className="text-xs text-muted-foreground">articles</span>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5">
                  {pieData.map((d) => (
                    <span
                      key={d.key}
                      className="flex items-center gap-1.5 text-xs text-muted-foreground"
                    >
                      <span
                        className="size-2.5 rounded-full"
                        style={{ backgroundColor: SENTIMENT_META[d.key].hex }}
                        aria-hidden
                      />
                      {d.name}
                      <span className="tabular-nums">{d.value}</span>
                    </span>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* 2. Score over time */}
        <Card className="gap-4">
          <CardHeader>
            <CardTitle className="text-base">Sentiment score — last 14 days</CardTitle>
          </CardHeader>
          <CardContent>
            {dailyData.length === 0 ? (
              <div className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">
                No daily data yet
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={dailyData} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                  <defs>
                    <linearGradient id="score-area-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="#f59e0b" stopOpacity={0.03} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="#a1a1aa"
                    strokeOpacity={0.25}
                    vertical={false}
                  />
                  <XAxis
                    dataKey="date"
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11 }}
                    className={AXIS_TICK_CLS}
                    interval="preserveStartEnd"
                    minTickGap={16}
                  />
                  <YAxis
                    domain={[-1, 1]}
                    ticks={[-1, -0.5, 0, 0.5, 1]}
                    tickFormatter={(v: number) => v.toFixed(1)}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11 }}
                    className={AXIS_TICK_CLS}
                    width={48}
                  />
                  <Tooltip
                    contentStyle={tooltipContentStyle}
                    cursor={{ stroke: "#a1a1aa", strokeDasharray: "3 3" }}
                  />
                  <ReferenceLine
                    y={0}
                    stroke="#a1a1aa"
                    strokeDasharray="4 4"
                    className="dark:[&>path]:stroke-zinc-600"
                  />
                  <Area
                    type="monotone"
                    dataKey="avgScore"
                    name="Avg score"
                    stroke="#f59e0b"
                    strokeWidth={2}
                    fill="url(#score-area-fill)"
                    dot={false}
                    activeDot={{ r: 4 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* 3. Top keywords */}
        <Card className="gap-4">
          <CardHeader>
            <CardTitle className="text-base">Top keywords</CardTitle>
          </CardHeader>
          <CardContent>
            {keywordData.length === 0 ? (
              <div className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">
                No keywords extracted yet
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart
                  data={keywordData}
                  layout="vertical"
                  margin={{ top: 0, right: 16, left: 0, bottom: 0 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="#a1a1aa"
                    strokeOpacity={0.25}
                    horizontal={false}
                  />
                  <XAxis
                    type="number"
                    allowDecimals={false}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11 }}
                    className={AXIS_TICK_CLS}
                  />
                  <YAxis
                    type="category"
                    dataKey="term"
                    width={110}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11 }}
                    className={AXIS_TICK_CLS}
                  />
                  <Tooltip contentStyle={tooltipContentStyle} cursor={{ fill: "#a1a1aa", fillOpacity: 0.08 }} />
                  <Bar
                    dataKey="count"
                    name="Mentions"
                    fill="#f59e0b"
                    radius={[0, 4, 4, 0]}
                    barSize={14}
                  />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* 4. Model comparison */}
        <Card className="gap-4">
          <CardHeader>
            <CardTitle className="text-base">Model comparison</CardTitle>
          </CardHeader>
          <CardContent>
            {modelRows.length === 0 ? (
              <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                No model data yet
              </div>
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Model</TableHead>
                      <TableHead className="text-right">Articles</TableHead>
                      <TableHead className="text-right">Avg score</TableHead>
                      <TableHead className="text-right">Avg latency</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {modelRows.map((m) => (
                      <TableRow key={m.model}>
                        <TableCell className="font-medium">{m.model}</TableCell>
                        <TableCell className="text-right tabular-nums">{m.count}</TableCell>
                        <TableCell
                          className={`text-right font-semibold tabular-nums ${scoreColorCls(m.avgScore ?? 0)}`}
                        >
                          {formatSigned(m.avgScore ?? 0)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {formatLatency(m.avgLatencyMs ?? 0)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <p className="mt-3 text-xs text-muted-foreground">
                  Latency = time to structured verdict.
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Recent analyses */}
      <Card className="gap-4">
        <CardHeader>
          <CardTitle className="text-base">Recent analyses</CardTitle>
        </CardHeader>
        <CardContent>
          {(stats.recent ?? []).length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">No recent analyses.</p>
          ) : (
            <ul className="max-h-72 space-y-1 overflow-y-auto pr-1 custom-scrollbar">
              {stats.recent.map((r) => {
                const meta = SENTIMENT_META[r.sentiment] ?? SENTIMENT_META.neutral;
                return (
                  <li
                    key={r.id}
                    className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted/50"
                  >
                    <span className={`size-2 shrink-0 rounded-full ${meta.dot}`} aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {r.title || "Untitled analysis"}
                    </span>
                    <Badge variant="outline" className="hidden gap-1 sm:inline-flex">
                      <Cpu aria-hidden />
                      {r.model}
                    </Badge>
                    <span
                      className={`w-12 shrink-0 text-right text-sm font-semibold tabular-nums ${scoreColorCls(r.score ?? 0)}`}
                    >
                      {formatSigned(r.score ?? 0)}
                    </span>
                    <span className="w-24 shrink-0 text-right text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(r.createdAt), { addSuffix: true })}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
