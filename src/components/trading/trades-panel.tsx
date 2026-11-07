"use client";

import * as React from "react";
import { History, Loader2, Trash2, Wallet, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { formatPct, formatPrice, timeAgo } from "@/lib/format";
import {
  PAPER_START_BALANCE,
  type OpenTradeRow,
  type TradeExitReason,
  type TradeRow,
  type TradesResponse,
} from "@/lib/types";

export interface TradesPanelProps {
  /** Full server response; null while loading for the first time. */
  trades: TradesResponse | null;
  loading: boolean;
  /** Request a manual market close of an OPEN trade (parent handles confirm + API). */
  onCloseTrade: (id: string) => void;
  /** id of the trade currently being closed (show spinner on that row's button), or null */
  closingId: string | null;
  /** Wipe closed-trade history (parent handles confirm + API). */
  onDeleteClosed: () => void;
  /** Click a symbol to view its chart (parent switches the chart). */
  onSelectSymbol: (symbol: string) => void;
}

// ---------------------------------------------------------------------------
// Color tokens (emerald = profit, rose = loss, zinc = neutral, amber = accent)
// ---------------------------------------------------------------------------

const LONG_CHIP =
  "border-emerald-300 bg-emerald-100 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300";
const SHORT_CHIP =
  "border-rose-300 bg-rose-100 text-rose-800 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300";
const SL_TEXT = "text-rose-600 dark:text-rose-400";
const TP_TEXT = "text-emerald-600 dark:text-emerald-400";

const EXIT_CHIP: Record<TradeExitReason, { label: string; className: string }> = {
  TP: {
    label: "TP hit",
    className:
      "border-emerald-300 bg-emerald-100 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-400",
  },
  SL: {
    label: "SL hit",
    className:
      "border-rose-300 bg-rose-100 text-rose-700 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-400",
  },
  MANUAL: {
    label: "Closed manually",
    className:
      "border-zinc-300 bg-zinc-100 text-zinc-700 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  },
};

// ---------------------------------------------------------------------------
// Small formatting helpers
// ---------------------------------------------------------------------------

/** Signed USD P&L: "+12.50" / "-1,234.56" / "0.00". */
function signedUsd(v: number): string {
  if (v > 0) return `+${formatPrice(v)}`;
  if (v < 0) return `-${formatPrice(Math.abs(v))}`;
  return "0.00";
}

/** Emerald when positive, rose when negative, zinc when flat. */
function pnlTextClass(v: number): string {
  if (v > 0) return "text-emerald-600 dark:text-emerald-400";
  if (v < 0) return "text-rose-600 dark:text-rose-400";
  return "text-zinc-600 dark:text-zinc-400";
}

/** Trim to at most 6 decimals, dropping trailing zeros ("1.500000" → "1.5"). */
function formatQty(q: number): string {
  if (!Number.isFinite(q)) return "0";
  const s = q.toFixed(6).replace(/\.?0+$/, "");
  return s === "" ? "0" : s;
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function LoadingState() {
  return (
    <div className="space-y-4" aria-busy="true">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-20 animate-pulse rounded-xl bg-muted" />
        ))}
      </div>
      {Array.from({ length: 2 }).map((_, i) => (
        <div key={i} className="h-20 animate-pulse rounded-xl bg-muted" />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Open position row
// ---------------------------------------------------------------------------

interface OpenPositionItemProps {
  trade: OpenTradeRow;
  closing: boolean;
  onCloseTrade: (id: string) => void;
  onSelectSymbol: (symbol: string) => void;
}

function OpenPositionItem({
  trade: t,
  closing,
  onCloseTrade,
  onSelectSymbol,
}: OpenPositionItemProps) {
  const isLong = t.direction === "BUY";
  const progress = Math.max(0, Math.min(100, t.progressPct));

  return (
    <div className="rounded-xl border p-3">
      <div className="flex items-center gap-2">
        <Badge className={isLong ? LONG_CHIP : SHORT_CHIP}>
          {isLong ? "LONG" : "SHORT"}
        </Badge>
        <button
          type="button"
          onClick={() => onSelectSymbol(t.symbol)}
          aria-label={`View ${t.symbol} chart`}
          className="font-mono text-xs font-bold hover:underline"
        >
          {t.symbol}
        </button>
        <span
          className={`ml-auto inline-flex items-baseline gap-1.5 font-mono text-sm font-bold tabular-nums ${pnlTextClass(t.unrealizedPnl)}`}
        >
          <span>{signedUsd(t.unrealizedPnl)} USDT</span>
          <span className="text-xs font-semibold">{formatPct(t.unrealizedPct)}</span>
        </span>
      </div>

      <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
        <span>
          Entry <span className="font-mono tabular-nums">{formatPrice(t.entryPrice)}</span>
        </span>
        <span aria-hidden>·</span>
        <span>
          Now <span className="font-mono tabular-nums">{formatPrice(t.currentPrice)}</span>
        </span>
        <span aria-hidden>·</span>
        <span>
          SL <span className={`font-mono tabular-nums ${SL_TEXT}`}>{formatPrice(t.stopLoss)}</span>
        </span>
        <span aria-hidden>·</span>
        <span>
          TP <span className={`font-mono tabular-nums ${TP_TEXT}`}>{formatPrice(t.takeProfit)}</span>
        </span>
        <span aria-hidden>·</span>
        <span className="font-mono tabular-nums">{t.notional} USDT</span>
        <span aria-hidden>·</span>
        <span>
          qty <span className="font-mono tabular-nums">{formatQty(t.quantity)}</span>
        </span>
        <span aria-hidden>·</span>
        <span>{timeAgo(t.openedAt)}</span>
      </p>

      <div className="mt-2.5 flex items-center gap-3">
        <Progress
          value={progress}
          className="h-1.5 flex-1"
          aria-label="Progress from stop-loss to take-profit"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1 border-rose-300 text-rose-600 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-400 dark:hover:bg-rose-950/40"
          disabled={closing}
          onClick={() => onCloseTrade(t.id)}
          aria-label={`Close ${t.symbol} position`}
        >
          {closing ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <X className="size-3.5" aria-hidden />
          )}
          {closing ? "Closing…" : "Close"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Closed trade row
// ---------------------------------------------------------------------------

interface ClosedTradeItemProps {
  trade: TradeRow;
  onSelectSymbol: (symbol: string) => void;
}

function ClosedTradeItem({ trade: t, onSelectSymbol }: ClosedTradeItemProps) {
  const isLong = t.direction === "BUY";
  const exit = t.exitReason ? EXIT_CHIP[t.exitReason] : null;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border p-2.5">
      <span
        className={`rounded-md border px-1.5 py-0.5 text-[10px] font-bold ${isLong ? LONG_CHIP : SHORT_CHIP}`}
      >
        {isLong ? "LONG" : "SHORT"}
      </span>
      <button
        type="button"
        onClick={() => onSelectSymbol(t.symbol)}
        aria-label={`View ${t.symbol} chart`}
        className="font-mono text-xs font-semibold hover:underline"
      >
        {t.symbol}
      </button>
      <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
        {formatPrice(t.entryPrice)} → {t.exitPrice !== null ? formatPrice(t.exitPrice) : "—"}
      </span>
      {exit ? (
        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${exit.className}`}>
          {exit.label}
        </span>
      ) : null}
      <span
        className={`ml-auto inline-flex items-baseline font-mono text-xs font-bold tabular-nums ${
          t.pnl !== null ? pnlTextClass(t.pnl) : "text-muted-foreground"
        }`}
      >
        <span>{t.pnl !== null ? `${signedUsd(t.pnl)} USDT` : "—"}</span>
        {t.pnlPct !== null ? (
          <span className="ml-1 font-semibold">{formatPct(t.pnlPct)}</span>
        ) : null}
      </span>
      {t.closedAt ? (
        <span className="text-[10px] text-muted-foreground">{timeAgo(t.closedAt)}</span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TradesPanel
// ---------------------------------------------------------------------------

function TradesPanelImpl({
  trades,
  loading,
  onCloseTrade,
  closingId,
  onDeleteClosed,
  onSelectSymbol,
}: TradesPanelProps) {
  if (trades === null) {
    if (loading) return <LoadingState />;
    return <p className="text-sm text-muted-foreground">Paper account not loaded yet.</p>;
  }

  const { open, closed, stats } = trades;
  const realizedClass = pnlTextClass(stats.realizedPnl);
  const unrealizedClass = pnlTextClass(stats.unrealizedPnl);

  return (
    <div className="space-y-4">
      {/* Stats row */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl border p-3">
          <p className="text-[11px] text-muted-foreground">Paper equity</p>
          <p className="mt-1 font-mono text-lg font-bold tabular-nums">
            {formatPrice(stats.balance)}
            <span className="ml-1 text-[10px] font-semibold text-muted-foreground">USDT</span>
          </p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            start {PAPER_START_BALANCE.toLocaleString()} USDT + P&L
          </p>
        </div>

        <div className="rounded-xl border p-3">
          <p className="text-[11px] text-muted-foreground">Realized P&L</p>
          <p className={`mt-1 font-mono text-lg font-bold tabular-nums ${realizedClass}`}>
            {signedUsd(stats.realizedPnl)} USDT
          </p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            across {stats.closedCount} closed trades
          </p>
        </div>

        <div className="rounded-xl border p-3">
          <p className="text-[11px] text-muted-foreground">Win rate</p>
          <p className="mt-1 font-mono text-lg font-bold tabular-nums">
            {stats.winRate.toFixed(0)}%
          </p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            <span className={stats.wins > 0 ? TP_TEXT : ""}>{stats.wins}W</span>
            {" / "}
            <span className={stats.losses > 0 ? SL_TEXT : ""}>{stats.losses}L</span>
          </p>
        </div>

        <div className="rounded-xl border p-3">
          <p className="text-[11px] text-muted-foreground">Open positions</p>
          <p className="mt-1 font-mono text-lg font-bold tabular-nums">{stats.openCount}</p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            unrealized{" "}
            <span className={`font-semibold ${unrealizedClass}`}>
              {signedUsd(stats.unrealizedPnl)} USDT
            </span>
          </p>
        </div>
      </div>

      {/* Open positions */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wallet className="size-4 text-amber-500" aria-hidden />
            Open positions
          </CardTitle>
        </CardHeader>
        <CardContent>
          {open.length === 0 ? (
            <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
              No open paper trades — simulate one from a BUY/SELL signal in the feed or the signal
              card.
            </div>
          ) : (
            <div
              className="custom-scrollbar max-h-96 space-y-2 overflow-y-auto pr-1"
              aria-label="Open paper trades"
            >
              {open.map((t) => (
                <OpenPositionItem
                  key={t.id}
                  trade={t}
                  closing={closingId === t.id}
                  onCloseTrade={onCloseTrade}
                  onSelectSymbol={onSelectSymbol}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Trade history */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <History className="size-4 text-amber-500" aria-hidden />
            Trade history
          </CardTitle>
          <CardAction>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-xs text-muted-foreground hover:text-rose-500"
              onClick={onDeleteClosed}
              aria-label="Clear closed trade history"
            >
              <Trash2 className="size-3.5" aria-hidden />
              Clear
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {closed.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Closed trades and their P&L will be stored here.
            </p>
          ) : (
            <div
              className="custom-scrollbar max-h-72 space-y-1.5 overflow-y-auto pr-1"
              aria-label="Closed paper trades"
            >
              {closed.map((t) => (
                <ClosedTradeItem key={t.id} trade={t} onSelectSymbol={onSelectSymbol} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted-foreground">
        Paper trades fill at the live Binance price. Positions auto-close when price touches SL or
        TP (stop-loss is evaluated first if both are hit between refreshes). Educational simulation
        — no real funds.
      </p>
    </div>
  );
}

export const TradesPanel = React.memo(TradesPanelImpl);
