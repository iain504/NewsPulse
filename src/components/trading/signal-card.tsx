"use client";

import * as React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Gauge,
  Loader2,
  Minus,
  ShieldAlert,
  TrendingDown,
  TrendingUp,
  Zap,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fetchJSON } from "@/lib/sse-client";
import { formatPrice, formatQty } from "@/lib/format";
import {
  NOTIONAL_OPTIONS,
  SIGNAL_META,
  type MarketSnapshot,
  type SignalDirection,
  type StructuredSignal,
  type SizingMode,
  type SizingResponse,
} from "@/lib/types";

export type SignalStatus = "idle" | "fetching" | "thinking" | "ready" | "error";

interface SignalCardProps {
  status: SignalStatus;
  symbol: string;
  interval: string;
  signal: StructuredSignal | null;
  snapshot: MarketSnapshot | null;
  rationale: string;
  streaming: boolean;
  error: string | null;
  model: string;
  latencyMs: number;
  source: string;
  // paper-trading actions (optional)
  signalId?: string | null;
  canSimulate?: boolean;
  simulating?: boolean;
  /** "auto" = confidence-driven risk sizing · "fixed" = user-picked USDT amount */
  sizingMode?: SizingMode;
  onSizingModeChange?: (m: SizingMode) => void;
  notional?: number;
  onNotionalChange?: (n: number) => void;
  /** Auto-trade confidence threshold (0..1) — floor of the risk-scaling curve. */
  minConfidence?: number;
  onSimulate?: () => void;
  openTradeHint?: string | null;
}

function DirectionIcon({ direction, className }: { direction: SignalDirection; className?: string }) {
  if (direction === "BUY") return <TrendingUp className={className} aria-hidden />;
  if (direction === "SELL") return <TrendingDown className={className} aria-hidden />;
  return <Minus className={className} aria-hidden />;
}

/** Horizontal price ladder: SL → entry zone → TP, with current price marker. */
function PriceLadder({ signal, lastPrice }: { signal: StructuredSignal; lastPrice: number }) {
  const values = [signal.stopLoss, signal.takeProfit, signal.entryLow, signal.entryHigh, lastPrice].filter(
    (v) => Number.isFinite(v) && v > 0,
  );
  if (values.length < 3) return null;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const pos = (v: number) => `${Math.min(100, Math.max(0, ((v - lo) / span) * 100))}%`;

  const zoneL = pos(Math.min(signal.entryLow, signal.entryHigh));
  const zoneR = pos(Math.max(signal.entryLow, signal.entryHigh));

  return (
    <div className="space-y-2">
      <div className="relative h-12 overflow-visible rounded-lg border bg-muted/40">
        {/* entry zone */}
        <div
          className="absolute inset-y-1.5 border-x-2 border-dashed border-amber-500 bg-amber-500/15"
          style={{ left: zoneL, width: `calc(${zoneR} - ${zoneL})` }}
          aria-hidden
        />
        {/* SL marker */}
        <div className="absolute inset-y-0 w-0.5 bg-rose-500" style={{ left: pos(signal.stopLoss) }} aria-hidden />
        {/* TP marker */}
        <div className="absolute inset-y-0 w-0.5 bg-emerald-500" style={{ left: pos(signal.takeProfit) }} aria-hidden />
        {/* entry marker */}
        <div
          className="absolute inset-y-0 w-px bg-amber-500"
          style={{ left: pos(signal.entry) }}
          aria-hidden
        />
        {/* current price */}
        <div
          className="absolute top-1 bottom-1 w-px bg-zinc-900 dark:bg-white"
          style={{ left: pos(lastPrice) }}
          aria-hidden
        />
        <div
          className="absolute -top-0.5 -translate-x-1/2 rounded-sm bg-zinc-900 px-1 py-px text-[9px] font-bold text-white dark:bg-white dark:text-zinc-900"
          style={{ left: pos(lastPrice) }}
        >
          NOW
        </div>
      </div>
      <div className="relative h-4 text-[10px] leading-4">
        <span className="absolute -translate-x-1/2 font-semibold text-rose-600 dark:text-rose-400" style={{ left: pos(signal.stopLoss) }}>
          SL {formatPrice(signal.stopLoss)}
        </span>
        <span className="absolute -translate-x-1/2 font-semibold text-amber-600 dark:text-amber-400" style={{ left: pos(signal.entry) }}>
          {formatPrice(signal.entry)}
        </span>
        <span className="absolute -translate-x-1/2 font-semibold text-emerald-600 dark:text-emerald-400" style={{ left: pos(signal.takeProfit) }}>
          TP {formatPrice(signal.takeProfit)}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confidence-driven sizing preview (server-computed, live price)
// ---------------------------------------------------------------------------

function SizingPreviewBox({
  signalId,
  mode,
  notional,
  minConfidence,
}: {
  signalId: string;
  mode: SizingMode;
  notional: number;
  minConfidence: number;
}) {
  const [data, setData] = React.useState<SizingResponse | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    const url =
      `/api/trades/sizing?signalId=${encodeURIComponent(signalId)}` +
      `&minConfidence=${minConfidence}` +
      (mode === "fixed" ? `&notional=${notional}` : "");
    fetchJSON<SizingResponse>(url)
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setFailed(false);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [signalId, mode, notional, minConfidence]);

  if (failed) return null;
  if (!data) {
    return (
      <div className="h-12 animate-pulse rounded-lg bg-muted/60" aria-hidden />
    );
  }

  const preview = mode === "auto" ? data.auto : data.fixed;
  if (!preview) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-dashed bg-muted/40 px-2.5 py-1.5 text-[11px] leading-snug"
      data-testid="sizing-preview"
    >
      {mode === "auto" ? (
        <span className="inline-flex items-center gap-1 font-semibold text-amber-700 dark:text-amber-400">
          <Gauge className="size-3.5" aria-hidden />
          ×{preview.multiplier.toFixed(2)} risk scale
        </span>
      ) : null}
      <span>
        Position <span className="font-mono font-semibold tabular-nums">{formatPrice(preview.notional)}</span> USDT
      </span>
      <span>
        risks{" "}
        <span className="font-mono font-semibold tabular-nums text-rose-600 dark:text-rose-400">
          {formatPrice(preview.riskAmount)}
        </span>{" "}
        USDT ({preview.riskPct.toFixed(2)}% equity) if SL hits
      </span>
      <span className="text-muted-foreground">
        stop {preview.stopPct.toFixed(2)}% away · qty {formatQty(preview.quantity)} · equity{" "}
        {formatPrice(data.equity)} USDT
      </span>
      {preview.capped ? <span className="font-semibold text-amber-600 dark:text-amber-400">(capped ×5)</span> : null}
    </div>
  );
}

export function SignalCard(props: SignalCardProps) {
  const {
    status,
    symbol,
    interval,
    signal,
    snapshot,
    rationale,
    streaming,
    error,
    model,
    latencyMs,
    source,
    signalId,
    canSimulate,
    simulating,
    sizingMode = "auto",
    onSizingModeChange,
    notional = 500,
    onNotionalChange,
    minConfidence = 0.7,
    onSimulate,
    openTradeHint,
  } = props;

  if (status === "idle") {
    return (
      <div className="flex h-full min-h-64 flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-8 text-center">
        <ShieldAlert className="size-8 text-muted-foreground/50" aria-hidden />
        <p className="text-sm font-medium">No signal yet</p>
        <p className="max-w-xs text-xs text-muted-foreground">
          Hit <span className="font-semibold">Analyze now</span> to fetch fresh Binance bars and let the
          model propose an entry, stop-loss and take-profit. Or turn on auto-scan.
        </p>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="flex h-full min-h-64 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-rose-300 bg-rose-50/50 p-8 text-center dark:border-rose-900 dark:bg-rose-950/20">
        <AlertTriangle className="size-8 text-rose-500" aria-hidden />
        <p className="text-sm font-semibold text-rose-600 dark:text-rose-400">Analysis failed</p>
        <p className="max-w-sm text-xs text-muted-foreground">{error ?? "Unknown error"}</p>
      </div>
    );
  }

  const pending = status === "fetching" || status === "thinking";
  const stage = status === "fetching" ? "Fetching Binance bars & computing indicators…" : "Model is reading the tape…";
  const meta = signal ? SIGNAL_META[signal.direction] : null;

  const sizeSelectValue = sizingMode === "auto" ? "auto" : String(notional);
  const sizeLabel =
    sizingMode === "auto" ? "auto size" : `${notional.toLocaleString()} USDT`;

  return (
    <div className="space-y-4">
      {/* header */}
      <div className="flex flex-wrap items-center gap-2">
        {signal && meta ? (
          <span className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-bold ${meta.badge}`}>
            <DirectionIcon direction={signal.direction} className="size-4" aria-hidden />
            {meta.label}
          </span>
        ) : (
          <span className="inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium text-muted-foreground">
            <span className="size-3 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" aria-hidden />
            {stage}
          </span>
        )}
        <Badge variant="outline" className="font-mono text-[11px]">
          {symbol} · {interval}
        </Badge>
        {signal && (
          <Badge variant="outline" className="text-[11px] capitalize">
            {signal.timeHorizon}
          </Badge>
        )}
        <Badge variant="outline" className="text-[11px]">
          {source === "auto" ? "auto-scan" : "manual"}
        </Badge>
        <span className="ml-auto text-[10px] text-muted-foreground">
          {model}
          {latencyMs > 0 ? ` · ${(latencyMs / 1000).toFixed(1)}s` : ""}
        </span>
      </div>

      {/* confidence */}
      {signal && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Confidence</span>
            <span className="font-semibold">{Math.round(signal.confidence * 100)}%</span>
          </div>
          <Progress value={signal.confidence * 100} className="h-2" />
        </div>
      )}

      {/* levels */}
      {signal && snapshot && (
        <div className="space-y-3 rounded-xl border p-3">
          {signal.direction === "WAIT" ? (
            <p className="text-center text-sm text-muted-foreground">
              The model recommends <span className="font-semibold">standing aside</span> — trend, momentum and
              volume don&apos;t align into a high-quality setup right now.
            </p>
          ) : (
            <>
              <PriceLadder signal={signal} lastPrice={snapshot.lastPrice} />
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg bg-rose-50 p-2 dark:bg-rose-950/30">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-rose-600 dark:text-rose-400">Stop loss</p>
                  <p className="font-mono text-sm font-bold text-rose-700 dark:text-rose-300">{formatPrice(signal.stopLoss)}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {(((signal.entry - signal.stopLoss) / signal.entry) * 100).toFixed(2)}% risk
                  </p>
                </div>
                <div className="rounded-lg bg-amber-50 p-2 dark:bg-amber-950/30">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400">Entry zone</p>
                  <p className="font-mono text-sm font-bold text-amber-700 dark:text-amber-300">
                    {formatPrice(signal.entryLow)}–{formatPrice(signal.entryHigh)}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    last {formatPrice(snapshot.lastPrice)}
                  </p>
                </div>
                <div className="rounded-lg bg-emerald-50 p-2 dark:bg-emerald-950/30">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-emerald-600 dark:text-emerald-400">Take profit</p>
                  <p className="font-mono text-sm font-bold text-emerald-700 dark:text-emerald-300">{formatPrice(signal.takeProfit)}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {(((signal.takeProfit - signal.entry) / signal.entry) * 100).toFixed(2)}% reward
                  </p>
                </div>
              </div>
              <div className="flex items-center justify-center gap-2 text-xs">
                <Badge variant="outline" className="border-amber-300 bg-amber-50 font-bold text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
                  R:R {signal.rrRatio.toFixed(2)}
                </Badge>
                <span className="text-muted-foreground">{signal.summary}</span>
              </div>
              {onSimulate && (
                <div className="space-y-2 border-t pt-3">
                  {canSimulate ? (
                    <>
                      <div className="flex items-center gap-2">
                        <Select
                          value={sizeSelectValue}
                          onValueChange={(v) => {
                            if (v === "auto") onSizingModeChange?.("auto");
                            else {
                              onSizingModeChange?.("fixed");
                              onNotionalChange?.(Number(v));
                            }
                          }}
                        >
                          <SelectTrigger className="h-8 w-44 shrink-0 text-xs" aria-label="Position sizing mode">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="auto">Auto · confidence-based</SelectItem>
                            {NOTIONAL_OPTIONS.map((n) => (
                              <SelectItem key={n} value={String(n)}>
                                Fixed · {n.toLocaleString()} USDT
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          size="sm"
                          disabled={simulating}
                          onClick={onSimulate}
                          className={`h-8 flex-1 gap-1.5 font-semibold text-white ${
                            signal.direction === "BUY"
                              ? "bg-emerald-600 hover:bg-emerald-500"
                              : "bg-rose-600 hover:bg-rose-500"
                          }`}
                          aria-label={`Simulate a paper ${signal.direction === "BUY" ? "long" : "short"} trade — ${sizeLabel}`}
                        >
                          {simulating ? (
                            <Loader2 className="size-4 animate-spin" aria-hidden />
                          ) : (
                            <Zap className="size-4" aria-hidden />
                          )}
                          {simulating
                            ? "Placing…"
                            : `Simulate ${signal.direction === "BUY" ? "long" : "short"} · ${sizeLabel}`}
                        </Button>
                      </div>
                      {signalId ? (
                        <SizingPreviewBox
                          signalId={signalId}
                          mode={sizingMode}
                          notional={notional}
                          minConfidence={minConfidence}
                        />
                      ) : null}
                    </>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">
                      {openTradeHint ?? "A paper position is already open — single-position mode allows one trade at a time."}
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* reasons & risks */}
      {signal && (signal.reasons.length > 0 || signal.risks.length > 0) && (
        <div className="grid gap-3 sm:grid-cols-2">
          {signal.reasons.length > 0 && (
            <div className="rounded-xl border p-3">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                Why
              </p>
              <ul className="space-y-1.5">
                {signal.reasons.map((r, i) => (
                  <li key={i} className="flex gap-1.5 text-xs leading-relaxed">
                    <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-500" aria-hidden />
                    <span>{r}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {signal.risks.length > 0 && (
            <div className="rounded-xl border p-3">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                Risks
              </p>
              <ul className="space-y-1.5">
                {signal.risks.map((r, i) => (
                  <li key={i} className="flex gap-1.5 text-xs leading-relaxed">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" aria-hidden />
                    <span>{r}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* streamed plan */}
      {(rationale || streaming) && (
        <div className="rounded-xl border bg-muted/30 p-3">
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Trading plan
          </p>
          <p className="text-sm leading-relaxed">
            {rationale}
            {streaming && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-amber-500 align-middle" aria-hidden />}
          </p>
        </div>
      )}
    </div>
  );
}
