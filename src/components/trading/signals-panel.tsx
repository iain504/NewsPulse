"use client";

import * as React from "react";
import {
  Activity,
  Bot,
  ChevronDown,
  ChevronRight,
  Crosshair,
  Eye,
  Loader2,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Timer,
  Trash2,
  Wallet,
  X,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { CandleChart } from "@/components/trading/candle-chart";
import { SignalCard, type SignalStatus } from "@/components/trading/signal-card";
import { TradesPanel } from "@/components/trading/trades-panel";
import { fetchJSON, postSSE } from "@/lib/sse-client";
import { formatCompact, formatPct, formatPrice, timeAgo } from "@/lib/format";
import {
  RISK_PROFILES,
  SCAN_INTERVALS,
  SIGNAL_META,
  TIMEFRAMES,
  type CandleRow,
  type ChartMarker,
  type EngineEventRow,
  type EngineResponse,
  type MarketSnapshot,
  type OpenTradeRow,
  type SizingMode,
  type SignalRow,
  type StructuredSignal,
  type TickerRow,
  type Timeframe,
  type TradeRow,
  type TradesResponse,
  type WatchItemRow,
} from "@/lib/types";

const SYMBOL_RE = /^[A-Z0-9]{5,15}$/;

/** Dot color per engine event type. */
const EVENT_DOT: Record<string, string> = {
  open: "bg-emerald-500",
  close: "bg-emerald-500",
  error: "bg-rose-500",
  signal: "bg-amber-500",
  skip: "bg-zinc-400",
  scan: "bg-zinc-300 dark:bg-zinc-600",
  info: "bg-zinc-300 dark:bg-zinc-600",
};

interface SnapshotEvent {
  snapshot: MarketSnapshot;
}
interface SignalEvent {
  signal: StructuredSignal;
  latencyMs: number;
  model: string;
}
interface ErrorEvent {
  message: string;
}

export function SignalsPanel() {
  // ---- market state ----
  const [symbol, setSymbol] = React.useState("BTCUSDT");
  const [timeframe, setTimeframe] = React.useState<Timeframe>("15m");
  const [candles, setCandles] = React.useState<CandleRow[]>([]);
  const [ticker, setTicker] = React.useState<TickerRow | null>(null);
  const [quotes, setQuotes] = React.useState<Record<string, TickerRow>>({});
  const [chartLoading, setChartLoading] = React.useState(true);
  const [chartError, setChartError] = React.useState<string | null>(null);
  const [watchItems, setWatchItems] = React.useState<WatchItemRow[]>([]);
  const [customSymbol, setCustomSymbol] = React.useState("");

  // ---- analysis state ----
  const [model, setModel] = React.useState("edge0-35b");
  const [riskProfile, setRiskProfile] = React.useState("balanced");
  const [status, setStatus] = React.useState<SignalStatus>("idle");
  const [snapshot, setSnapshot] = React.useState<MarketSnapshot | null>(null);
  const [signal, setSignal] = React.useState<StructuredSignal | null>(null);
  const [rationale, setRationale] = React.useState("");
  const [streaming, setStreaming] = React.useState(false);
  const [analysisError, setAnalysisError] = React.useState<string | null>(null);
  const [latency, setLatency] = React.useState(0);
  const [analyzedKey, setAnalyzedKey] = React.useState("");
  const [analyzedSymbol, setAnalyzedSymbol] = React.useState("");
  const [signalId, setSignalId] = React.useState<string | null>(null);

  // ---- automation engine (state lives on the SERVER, persisted in the DB) ----
  const [engine, setEngine] = React.useState<EngineResponse | null>(null);
  const [engineEvents, setEngineEvents] = React.useState<EngineEventRow[]>([]);
  const [engineBusy, setEngineBusy] = React.useState(false);
  const [nowTick, setNowTick] = React.useState(Date.now());

  // local slider copies (synced from the persisted config on first load)
  const [scanMinutes, setScanMinutes] = React.useState<number>(15);
  const [minConfidence, setMinConfidence] = React.useState(70);
  const [minRR, setMinRR] = React.useState(1.8);
  // unattended-scan brain (model / timeframe / risk profile) — persisted on the
  // server exactly like the armed flags, so every device sees the same config
  const [engineModel, setEngineModel] = React.useState("edge0-35b");
  const [engineInterval, setEngineInterval] = React.useState<Timeframe>("15m");
  const [engineRiskProfile, setEngineRiskProfile] = React.useState("balanced");
  const engineSyncedRef = React.useRef(false);
  const patchDebounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const watchlist = React.useMemo(() => watchItems.map((i) => i.symbol), [watchItems]);

  // ---- feed ----
  const [feed, setFeed] = React.useState<SignalRow[]>([]);
  const [feedLoading, setFeedLoading] = React.useState(true);
  const [feedFilter, setFeedFilter] = React.useState("all");
  const [expandedId, setExpandedId] = React.useState<string | null>(null);

  // ---- paper trading ----
  const [trades, setTrades] = React.useState<TradesResponse | null>(null);
  const [tradesLoading, setTradesLoading] = React.useState(true);
  const [closingId, setClosingId] = React.useState<string | null>(null);
  const [sizingMode, setSizingMode] = React.useState<SizingMode>("auto");
  const [notional, setNotional] = React.useState(500);
  const [simulatingId, setSimulatingId] = React.useState<string | null>(null);
  const openIdsRef = React.useRef<Set<string>>(new Set());

  const refreshFeed = React.useCallback(async () => {
    try {
      const res = await fetchJSON<{ ok: boolean; signals: SignalRow[] }>("/api/signals?limit=40");
      setFeed(res.signals);
    } catch {
      // feed is non-critical
    } finally {
      setFeedLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refreshFeed();
  }, [refreshFeed]);

  // ---- engine status + activity log (polling keeps every device in sync) ----
  const loadEngine = React.useCallback(async () => {
    try {
      const res = await fetchJSON<EngineResponse>("/api/engine");
      setEngine(res);
      const nextMin = Math.round(res.config.minConfidence * 100);
      if (!engineSyncedRef.current) {
        engineSyncedRef.current = true;
        setScanMinutes(res.config.scanMinutes);
        setMinConfidence(nextMin);
        setMinRR(res.config.minRR);
        setEngineModel(res.config.model);
        setEngineInterval(res.config.interval as Timeframe);
        setEngineRiskProfile(res.config.riskProfile);
      } else if (patchDebounceRef.current === null) {
        // no local edit in flight — adopt the server values (keeps devices in sync)
        setScanMinutes((m) => (m !== res.config.scanMinutes ? res.config.scanMinutes : m));
        setMinConfidence((c) => (c !== nextMin ? nextMin : c));
        setMinRR((r) => (r !== res.config.minRR ? res.config.minRR : r));
        setEngineModel((m) => (m !== res.config.model ? res.config.model : m));
        setEngineInterval((iv) => (iv !== res.config.interval ? (res.config.interval as Timeframe) : iv));
        setEngineRiskProfile((rp) => (rp !== res.config.riskProfile ? res.config.riskProfile : rp));
      }
    } catch {
      // keep the last known state
    }
  }, []);

  const loadEngineEvents = React.useCallback(async () => {
    try {
      const res = await fetchJSON<{ ok: boolean; events: EngineEventRow[] }>(
        "/api/engine/events?limit=14",
      );
      setEngineEvents(res.events);
    } catch {
      // keep the last known log
    }
  }, []);

  React.useEffect(() => {
    void loadEngine();
    void loadEngineEvents();
    const iv = setInterval(() => {
      void loadEngine();
      void loadEngineEvents();
    }, 10_000);
    return () => clearInterval(iv);
  }, [loadEngine, loadEngineEvents]);

  // 1-second ticker for the countdown while the engine is armed
  React.useEffect(() => {
    if (!engine?.config.armed) return;
    setNowTick(Date.now());
    const iv = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [engine?.config.armed]);

  /** Persist a config change on the server (armed flags, thresholds…). */
  const updateEngine = React.useCallback(
    async (patch: Record<string, unknown>) => {
      setEngineBusy(true);
      try {
        const res = await fetchJSON<EngineResponse>("/api/engine", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        setEngine(res);
        void loadEngineEvents();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Engine update failed.");
      } finally {
        setEngineBusy(false);
      }
    },
    [loadEngineEvents],
  );

  /** Slider / interval edits — batch rapid changes into one request. */
  const queueEnginePatch = React.useCallback(
    (patch: Record<string, unknown>) => {
      if (patchDebounceRef.current) clearTimeout(patchDebounceRef.current);
      patchDebounceRef.current = setTimeout(() => {
        patchDebounceRef.current = null;
        void updateEngine(patch);
      }, 600);
    },
    [updateEngine],
  );

  // restore position-sizing preference (mode + fixed amount)
  React.useEffect(() => {
    try {
      const saved = localStorage.getItem("np.sizing");
      if (!saved) return;
      const cfg = JSON.parse(saved) as { mode?: string; fixed?: number };
      if (cfg.mode === "auto" || cfg.mode === "fixed") setSizingMode(cfg.mode);
      if (typeof cfg.fixed === "number" && cfg.fixed >= 10 && cfg.fixed <= 1_000_000) {
        setNotional(cfg.fixed);
      }
    } catch {
      // ignore malformed storage
    }
  }, []);

  React.useEffect(() => {
    localStorage.setItem("np.sizing", JSON.stringify({ mode: sizingMode, fixed: notional }));
  }, [sizingMode, notional]);

  // ---- DB-backed watchlist ----
  const loadWatchlist = React.useCallback(async () => {
    try {
      const res = await fetchJSON<{ ok: boolean; items: WatchItemRow[] }>("/api/watchlist");
      setWatchItems(res.items);
    } catch {
      // keep the current list on failure
    }
  }, []);

  React.useEffect(() => {
    void loadWatchlist();
  }, [loadWatchlist]);

  // ---- chart data (30s refresh) ----
  const loadChart = React.useCallback(async () => {
    setChartLoading(true);
    setChartError(null);
    try {
      const res = await fetchJSON<{ ok: boolean; candles: CandleRow[]; ticker: TickerRow | null }>(
        `/api/market/klines?symbol=${encodeURIComponent(symbol)}&interval=${timeframe}&limit=150`,
      );
      setCandles(res.candles);
      setTicker(res.ticker);
    } catch (err) {
      setChartError(err instanceof Error ? err.message : "Failed to load chart data.");
    } finally {
      setChartLoading(false);
    }
  }, [symbol, timeframe]);

  React.useEffect(() => {
    void loadChart();
    const iv = setInterval(() => {
      if (document.visibilityState === "visible") void loadChart();
    }, 30_000);
    return () => clearInterval(iv);
  }, [loadChart]);

  // ---- watchlist quotes (12s refresh) ----
  const loadQuotes = React.useCallback(async () => {
    if (watchlist.length === 0) return;
    try {
      const res = await fetchJSON<{ ok: boolean; tickers: TickerRow[] }>(
        `/api/market/quote?symbols=${encodeURIComponent(watchlist.join(","))}`,
      );
      const map: Record<string, TickerRow> = {};
      for (const t of res.tickers) map[t.symbol] = t;
      setQuotes(map);
    } catch {
      // keep last quotes
    }
  }, [watchlist]);

  React.useEffect(() => {
    void loadQuotes();
    const iv = setInterval(loadQuotes, 12_000);
    return () => clearInterval(iv);
  }, [loadQuotes]);

  // ---- paper trades (10s polling also auto-closes SL/TP hits server-side) ----
  const loadTrades = React.useCallback(async (announce = false) => {
    try {
      const res = await fetchJSON<TradesResponse>("/api/trades");
      if (announce) {
        const prev = openIdsRef.current;
        for (const c of res.closed) {
          if (!prev.has(c.id) || c.exitReason === "MANUAL") continue;
          const pnl = c.pnl ?? 0;
          const txt = `${pnl >= 0 ? "+" : "-"}${formatPrice(Math.abs(pnl))} USDT (${formatPct(c.pnlPct ?? 0)})`;
          if (c.exitReason === "TP") {
            toast.success(`${c.symbol} take-profit hit — realized ${txt}`);
          } else if (c.exitReason === "SL") {
            toast.error(`${c.symbol} stop-loss hit — realized ${txt}`);
          }
        }
      }
      openIdsRef.current = new Set(res.open.map((t) => t.id));
      setTrades(res);
    } catch {
      // keep the last snapshot
    } finally {
      setTradesLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadTrades();
  }, [loadTrades]);

  React.useEffect(() => {
    const iv = setInterval(() => {
      if (document.visibilityState === "visible") void loadTrades(true);
    }, 10_000);
    return () => clearInterval(iv);
  }, [loadTrades]);

  // ---- paper trade actions ----
  const simulateTrade = React.useCallback(
    async (sigId: string) => {
      setSimulatingId(sigId);
      const autoSize = sizingMode === "auto";
      try {
        const res = await fetchJSON<{
          ok: boolean;
          trade: OpenTradeRow;
          riskPct: number | null;
          riskAmount: number | null;
        }>("/api/trades", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            signalId: sigId,
            autoSize,
            ...(autoSize ? {} : { notional }),
            minConfidence: minConfidence / 100,
          }),
        });
        const riskTxt =
          res.riskAmount !== null
            ? ` · risks ${formatPrice(res.riskAmount)} USDT (${(res.riskPct ?? 0).toFixed(2)}% equity)`
            : "";
        toast.success(
          `Paper ${res.trade.direction === "BUY" ? "long" : "short"} opened — ${res.trade.symbol} @ ${formatPrice(res.trade.entryPrice)} · ${res.trade.notional.toLocaleString()} USDT${riskTxt}`,
        );
        await loadTrades();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to open the paper trade.");
      } finally {
        setSimulatingId(null);
      }
    },
    [sizingMode, notional, minConfidence, loadTrades],
  );

  const closeTrade = React.useCallback(
    async (id: string) => {
      if (!window.confirm("Close this paper trade at the current market price?")) return;
      setClosingId(id);
      try {
        const res = await fetchJSON<{ ok: boolean; trade: TradeRow }>("/api/trades/close", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tradeId: id }),
        });
        const pnl = res.trade.pnl ?? 0;
        const txt = `${pnl >= 0 ? "+" : "-"}${formatPrice(Math.abs(pnl))} USDT`;
        if (pnl >= 0) toast.success(`${res.trade.symbol} closed manually — realized ${txt}`);
        else toast.error(`${res.trade.symbol} closed manually — realized ${txt}`);
        await loadTrades();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to close trade.");
      } finally {
        setClosingId(null);
      }
    },
    [loadTrades],
  );

  const clearClosedTrades = React.useCallback(async () => {
    if (!window.confirm("Clear the closed trade history? Open positions are kept.")) return;
    try {
      await fetchJSON("/api/trades?closed=1", { method: "DELETE" });
      await loadTrades();
      toast.success("Trade history cleared.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Clear failed");
    }
  }, [loadTrades]);

  const resetAccount = React.useCallback(async () => {
    if (
      !window.confirm(
        "Reset the paper account? ALL trades — open and closed — will be deleted and the balance returns to 10,000 USDT.",
      )
    )
      return;
    try {
      await fetchJSON("/api/trades?all=1", { method: "DELETE" });
      openIdsRef.current = new Set();
      await loadTrades();
      toast.success("Paper account reset.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Reset failed");
    }
  }, [loadTrades]);

  // ---- SSE analysis (manual only — automated scans run on the server) ----
  const analyzeSymbol = React.useCallback(
    async (sym: string): Promise<void> => {
      setStatus("fetching");
      setSignal(null);
      setRationale("");
      setStreaming(false);
      setAnalysisError(null);
      setLatency(0);
      setSignalId(null);
      setAnalyzedSymbol("");
      let errored = false;
      let errorMessage = "";
      try {
        await postSSE(
          "/api/signals/analyze",
          { symbol: sym, interval: timeframe, model, riskProfile, source: "manual" },
          {
            onEvent: (event, data) => {
              if (event === "snapshot") {
                setSnapshot((data as SnapshotEvent).snapshot);
                setStatus("thinking");
              } else if (event === "signal") {
                const sig = (data as SignalEvent).signal;
                setSignal(sig);
                setLatency((data as SignalEvent).latencyMs);
                setStatus("ready");
                setAnalyzedKey(`${sym}|${timeframe}`);
                setAnalyzedSymbol(sym);
              } else if (event === "delta") {
                setStreaming(true);
                setRationale((r) => r + (data as { t: string }).t);
              } else if (event === "done") {
                const doneData = data as { id?: string };
                if (doneData?.id) setSignalId(doneData.id);
                setStreaming(false);
                void refreshFeed();
              } else if (event === "error") {
                errored = true;
                errorMessage = (data as ErrorEvent).message;
                setAnalysisError(errorMessage);
                setStatus("error");
                setStreaming(false);
              }
            },
            onError: (err) => {
              errored = true;
              errorMessage = err.message;
              setAnalysisError(err.message);
              setStatus("error");
            },
          },
        );
      } catch (err) {
        errored = true;
        errorMessage = err instanceof Error ? err.message : "Request failed";
        setAnalysisError(errorMessage);
        setStatus("error");
      }
      if (errored) throw new Error(errorMessage || `${sym}: analysis failed`);
    },
    [timeframe, model, riskProfile, refreshFeed],
  );

  const analyzeNow = React.useCallback(async () => {
    try {
      await analyzeSymbol(symbol);
    } catch {
      // error already reflected in the card
    }
  }, [analyzeSymbol, symbol]);

  // ---- server-side engine controls ----
  const runScan = React.useCallback(async () => {
    setEngineBusy(true);
    try {
      const res = await fetchJSON<{ ok: boolean; reason?: string }>("/api/engine/tick", {
        method: "POST",
      });
      if (!res.ok) {
        toast.info(res.reason ?? "The engine is busy — try again in a moment.");
      } else {
        toast.info("Scan started on the server — verdicts will land in the feed below.");
      }
      await loadEngine();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start a scan.");
    } finally {
      setEngineBusy(false);
    }
  }, [loadEngine]);

  const toggleAuto = (on: boolean) => {
    void updateEngine({ armed: on });
    if (on) {
      toast.info(
        `Engine armed — the server scans every ${scanMinutes} min. You can close this tab; it keeps running.`,
      );
    } else {
      toast.info("Engine disarmed — server-side scanning and auto-trading stopped.");
    }
  };

  const toggleAutoTrade = (on: boolean) => {
    void updateEngine({ autoTrade: on });
    if (on) {
      toast.info(
        `Auto-trade armed — confidence ≥ ${minConfidence}% · R:R ≥ ${minRR.toFixed(1)} · one trade at a time.`,
      );
    } else {
      toast.info("Auto-trade disarmed — new signals will not open trades.");
    }
  };

  // ---- watchlist management (persisted in the database) ----
  const addSymbol = async () => {
    const s = customSymbol.trim().toUpperCase();
    if (!SYMBOL_RE.test(s)) {
      toast.error("Invalid symbol format — try e.g. LINKUSDT.");
      return;
    }
    if (watchlist.includes(s)) {
      toast.info(`${s} is already on the watchlist.`);
      setCustomSymbol("");
      return;
    }
    try {
      const res = await fetchJSON<{ ok: boolean; item: WatchItemRow }>("/api/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: s }),
      });
      setWatchItems((items) => [...items, res.item]);
      setCustomSymbol("");
      toast.success(`${s} added to the watchlist.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Could not add ${s}.`);
    }
  };

  const removeSymbol = async (s: string) => {
    try {
      await fetchJSON(`/api/watchlist?symbol=${encodeURIComponent(s)}`, { method: "DELETE" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Remove failed");
      return;
    }
    const next = watchItems.filter((x) => x.symbol !== s);
    setWatchItems(next);
    if (s === symbol && next.length > 0) setSymbol(next[0].symbol);
  };

  const toggleScan = async (item: WatchItemRow) => {
    const next = !item.scan;
    setWatchItems((items) => items.map((x) => (x.symbol === item.symbol ? { ...x, scan: next } : x)));
    try {
      await fetchJSON("/api/watchlist", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: item.symbol, scan: next }),
      });
    } catch (err) {
      setWatchItems((items) => items.map((x) => (x.symbol === item.symbol ? { ...x, scan: item.scan } : x)));
      toast.error(err instanceof Error ? err.message : "Could not update the scan flag");
    }
  };

  // ---- feed actions ----
  const deleteSignal = async (id: string) => {
    try {
      await fetchJSON(`/api/signals?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      setFeed((f) => f.filter((x) => x.id !== id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const clearAllSignals = async () => {
    if (!window.confirm("Delete all saved signals?")) return;
    try {
      await fetchJSON("/api/signals?all=1", { method: "DELETE" });
      setFeed([]);
      toast.success("Signal history cleared.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Clear failed");
    }
  };

  // ---- derived ----
  const pending = status === "fetching" || status === "thinking";
  const cardSymbol = analyzedSymbol || symbol;
  const openTradeForSymbol = trades?.open.find((t) => t.symbol === symbol) ?? null;
  const chartLevels = openTradeForSymbol
    ? {
        direction: openTradeForSymbol.direction,
        entry: openTradeForSymbol.entryPrice,
        entryLow: openTradeForSymbol.entryPrice,
        entryHigh: openTradeForSymbol.entryPrice,
        stopLoss: openTradeForSymbol.stopLoss,
        takeProfit: openTradeForSymbol.takeProfit,
      }
    : signal && analyzedKey === `${symbol}|${timeframe}` && signal.direction !== "WAIT"
      ? {
          direction: signal.direction,
          entry: signal.entry,
          entryLow: signal.entryLow,
          entryHigh: signal.entryHigh,
          stopLoss: signal.stopLoss,
          takeProfit: signal.takeProfit,
        }
      : null;

  const chartMarkers = React.useMemo<ChartMarker[]>(() => {
    if (candles.length === 0) return [];
    const first = candles[0].openTime;
    return feed
      .filter(
        (s): s is SignalRow & { direction: "BUY" | "SELL" } =>
          s.symbol === symbol && (s.direction === "BUY" || s.direction === "SELL"),
      )
      .map((s) => ({
        time: new Date(s.createdAt).getTime(),
        direction: s.direction,
        price: s.entry > 0 ? s.entry : s.price,
        at: s.createdAt,
      }))
      .filter((m) => m.time >= first)
      .sort((a, b) => a.time - b.time);
  }, [feed, symbol, candles]);

  // ---- engine-derived values ----
  const armed = engine?.config.armed ?? false;
  const autoTradeOn = engine?.config.autoTrade ?? false;
  const scanning = engine?.running ?? false;

  const remainingMs =
    armed && engine?.nextScanAt ? Math.max(0, new Date(engine.nextScanAt).getTime() - nowTick) : null;
  const countdown =
    remainingMs !== null
      ? `${Math.floor(remainingMs / 60000)}:${Math.floor((remainingMs % 60000) / 1000)
          .toString()
          .padStart(2, "0")}`
      : null;
  const countdownPct =
    remainingMs !== null ? Math.max(0, Math.min(100, (1 - remainingMs / (scanMinutes * 60000)) * 100)) : 0;

  const filteredFeed = feedFilter === "all" ? feed : feed.filter((s) => s.symbol === feedFilter);
  const counts = feed.reduce(
    (acc, s) => {
      acc[s.direction] = (acc[s.direction] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );
  const snapMatches = snapshot && analyzedKey === `${symbol}|${timeframe}` ? snapshot : null;

  return (
    <div className="space-y-5">
      {/* intro */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <Activity className="size-5 text-amber-500" aria-hidden />
            Trading Signal Terminal
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Live Binance bars → Edge0 verdicts with entry, SL &amp; TP — plotted on the chart and ready to
            simulate as paper trades. One position at a time, with an optional auto-trade engine that
            only takes signals clearing your R:R and confidence gates.
          </p>
        </div>
        <Badge variant="outline" className="border-amber-300 bg-amber-50 text-[11px] text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          Educational study tool — not financial advice
        </Badge>
      </div>

      {/* watchlist strip */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Radio className="size-3.5" aria-hidden /> Watchlist · live 24h · persisted
          </p>
          <div className="flex items-center gap-1.5">
            <Input
              value={customSymbol}
              onChange={(e) => setCustomSymbol(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === "Enter") void addSymbol();
              }}
              placeholder="Add e.g. LINKUSDT"
              className="h-8 w-40 text-xs"
              aria-label="Add symbol to watchlist"
            />
            <Button size="sm" variant="outline" className="h-8 gap-1 px-2" onClick={() => void addSymbol()}>
              <Plus className="size-3.5" aria-hidden /> Add
            </Button>
          </div>
        </div>
        <div className="custom-scrollbar flex gap-2 overflow-x-auto pb-1">
          {watchItems.map((item) => {
            const sym = item.symbol;
            const q = quotes[sym];
            const active = sym === symbol;
            const up = (q?.priceChangePercent ?? 0) >= 0;
            return (
              <div key={sym} className="relative shrink-0">
                {item.scan && (
                  <span
                    className="absolute -left-1 -top-1 z-10 size-2.5 rounded-full border border-background bg-amber-500"
                    title="Included in the auto-scan loop"
                    aria-hidden
                  />
                )}
                <button
                  type="button"
                  onClick={() => setSymbol(sym)}
                  className={`w-32 rounded-xl border p-2.5 text-left transition-colors ${
                    active
                      ? "border-amber-500 bg-amber-500/10"
                      : "border-border bg-card hover:border-amber-400/60 hover:bg-muted/50"
                  }`}
                  aria-pressed={active}
                  aria-label={`Show ${sym} chart`}
                >
                  <p className="flex items-center gap-1 text-xs font-bold">
                    {sym.replace("USDT", "")}
                    <span className="text-[9px] font-medium text-muted-foreground">/USDT</span>
                    {q && (
                      <span className={`ml-auto text-[10px] font-semibold ${up ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                        {formatPct(q.priceChangePercent)}
                      </span>
                    )}
                  </p>
                  <p className="mt-1 font-mono text-sm font-semibold tabular-nums">
                    {q ? formatPrice(q.lastPrice) : <span className="text-muted-foreground">…</span>}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {q ? `Vol ${formatCompact(q.quoteVolume)}` : "loading"}
                  </p>
                </button>
                {watchlist.length > 1 && (
                  <button
                    type="button"
                    onClick={() => void removeSymbol(sym)}
                    className="absolute -right-1.5 -top-1.5 hidden rounded-full border bg-background p-0.5 text-muted-foreground hover:text-rose-500 sm:block"
                    aria-label={`Remove ${sym} from watchlist`}
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* chart + engine */}
      <div className="grid gap-4 lg:grid-cols-5">
        {/* chart card */}
        <Card className="lg:col-span-3">
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <span className="font-mono">{symbol}</span>
                <span className="text-sm font-normal text-muted-foreground">· Binance spot</span>
                {openTradeForSymbol && (
                  <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
                    ● position open
                  </span>
                )}
                {ticker && (
                  <span className={`text-sm font-bold ${ticker.priceChangePercent >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                    {formatPrice(ticker.lastPrice)}{" "}
                    <span className="text-xs font-semibold">{formatPct(ticker.priceChangePercent)}</span>
                  </span>
                )}
              </CardTitle>
              <div className="flex items-center gap-1">
                <div className="flex rounded-lg border p-0.5" role="group" aria-label="Chart timeframe">
                  {TIMEFRAMES.map((tf) => (
                    <button
                      key={tf}
                      type="button"
                      onClick={() => setTimeframe(tf)}
                      className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                        timeframe === tf
                          ? "bg-zinc-900 text-amber-300 dark:bg-amber-500 dark:text-zinc-950"
                          : "text-muted-foreground hover:bg-muted"
                      }`}
                      aria-pressed={timeframe === tf}
                    >
                      {tf}
                    </button>
                  ))}
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  onClick={() => void loadChart()}
                  aria-label="Refresh chart"
                >
                  <RefreshCw className={`size-4 ${chartLoading ? "animate-spin" : ""}`} aria-hidden />
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {chartError ? (
              <div className="flex h-64 flex-col items-center justify-center gap-2 text-center">
                <p className="text-sm font-medium text-rose-600 dark:text-rose-400">{chartError}</p>
                <Button size="sm" variant="outline" onClick={() => void loadChart()}>
                  Retry
                </Button>
              </div>
            ) : chartLoading && candles.length === 0 ? (
              <div className="space-y-2">
                <div className="h-72 animate-pulse rounded-lg bg-muted" />
                <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
              </div>
            ) : (
              <CandleChart candles={candles} interval={timeframe} levels={chartLevels} markers={chartMarkers} />
            )}
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
              {ticker && (
                <>
                  <span>24h high {formatPrice(ticker.highPrice)}</span>
                  <span>24h low {formatPrice(ticker.lowPrice)}</span>
                  <span>24h vol {formatCompact(ticker.quoteVolume)}</span>
                </>
              )}
              {snapMatches && (
                <>
                  <span className="text-amber-600 dark:text-amber-400">RSI {snapMatches.rsi14.toFixed(1)}</span>
                  <span>ATR {formatPrice(snapMatches.atr14)} ({snapMatches.atrPct.toFixed(2)}%)</span>
                  <span className="truncate">{snapMatches.trendLabel}</span>
                </>
              )}
              {chartLevels && (
                <span className="font-semibold text-amber-600 dark:text-amber-400">
                  dashed lines = {openTradeForSymbol ? "open paper position levels" : "last signal levels"}
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        {/* engine card */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Crosshair className="size-4 text-amber-500" aria-hidden />
              Signal engine
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <p className="text-[11px] font-medium text-muted-foreground">Model</p>
                <Select value={model} onValueChange={setModel}>
                  <SelectTrigger className="h-8 text-xs" aria-label="Analysis model">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="edge0-35b">edge0-35b · deep</SelectItem>
                    <SelectItem value="edge0-8b">edge0-8b · fast</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <p className="text-[11px] font-medium text-muted-foreground">Risk profile</p>
                <Select value={riskProfile} onValueChange={setRiskProfile}>
                  <SelectTrigger className="h-8 text-xs" aria-label="Risk profile">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RISK_PROFILES.map((r) => (
                      <SelectItem key={r.value} value={r.value}>
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {RISK_PROFILES.find((r) => r.value === riskProfile)?.hint}
            </p>
            <Button
              onClick={() => void analyzeNow()}
              disabled={pending}
              className="w-full gap-2 bg-zinc-900 font-semibold text-amber-300 hover:bg-zinc-800 dark:bg-amber-500 dark:text-zinc-950 dark:hover:bg-amber-400"
            >
              {pending ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  {status === "fetching" ? "Fetching bars…" : "Model reasoning…"}
                </>
              ) : (
                <>
                  <Zap className="size-4" aria-hidden />
                  Analyze {symbol} now
                </>
              )}
            </Button>
            <div className="custom-scrollbar max-h-[540px] overflow-y-auto pr-1">
              <SignalCard
                status={status}
                symbol={cardSymbol}
                interval={timeframe}
                signal={signal}
                snapshot={snapshot}
                rationale={rationale}
                streaming={streaming}
                error={analysisError}
                model={model}
                latencyMs={latency}
                source="manual"
                canSimulate={
                  !!signalId && signal !== null && signal.direction !== "WAIT" && (trades?.open.length ?? 0) === 0
                }
                simulating={!!signalId && simulatingId === signalId}
                signalId={signalId}
                sizingMode={sizingMode}
                onSizingModeChange={setSizingMode}
                notional={notional}
                onNotionalChange={setNotional}
                minConfidence={minConfidence / 100}
                onSimulate={signalId ? () => void simulateTrade(signalId) : undefined}
                openTradeHint={
                  (trades?.open.length ?? 0) > 0
                    ? `Single-position mode — ${trades?.open[0]?.symbol ?? "a trade"} is still open. Close it before simulating another.`
                    : null
                }
              />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* automation: server-side scan loop + auto-trade engine */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Timer className="size-4 text-amber-500" aria-hidden />
              Automation
              <span className="text-xs font-normal text-muted-foreground">
                server-side engine · keeps running with the browser closed
              </span>
            </CardTitle>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{armed ? "On" : "Off"}</span>
              <Switch
                checked={armed}
                disabled={engineBusy || !engine}
                onCheckedChange={toggleAuto}
                aria-label="Toggle the automation engine"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* market data feed status — WebSocket first, REST governed */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl border bg-muted/30 px-3 py-2">
            <p className="flex items-center gap-1.5 text-xs font-semibold">
              <span
                className={`size-2 rounded-full ${
                  engine?.feed?.connected ? "bg-emerald-500 animate-pulse" : "bg-amber-500"
                }`}
                aria-hidden
              />
              {engine?.feed?.connected
                ? `Live WebSocket feed · ${engine.feed.symbols} symbol${engine.feed.symbols === 1 ? "" : "s"} · ${engine.feed.streams} streams`
                : "Market feed connecting…"}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {engine?.rest?.bannedUntil
                ? `Binance REST banned until ${new Date(engine.rest.bannedUntil).toLocaleTimeString([], { hour12: false })} — WebSocket keeps data live`
                : `Binance REST governed · ${engine?.rest?.weightUsed ?? 0}/${engine?.rest?.budgetPerMin ?? 40} weight per min (used only for one-time history bootstrap)`}
            </p>
          </div>

          {/* auto-trade engine */}
          <div
            className={`space-y-3 rounded-xl border p-3 transition-colors ${
              autoTradeOn
                ? "border-amber-400/70 bg-amber-50/60 dark:border-amber-700 dark:bg-amber-950/20"
                : ""
            }`}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold">
                  <Bot className="size-4 text-amber-500" aria-hidden />
                  Auto-trade engine
                  <span
                    className={`rounded-full border px-1.5 py-px text-[10px] font-bold ${
                      autoTradeOn
                        ? "border-emerald-300 bg-emerald-100 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-400"
                        : "border-border text-muted-foreground"
                    }`}
                  >
                    {autoTradeOn ? "ARMED" : "OFF"}
                  </span>
                </p>
                <p className="mt-0.5 max-w-xl text-[11px] leading-relaxed text-muted-foreground">
                  Scan signals that clear both gates open a paper trade automatically at the live price —
                  confidence ≥ {minConfidence}% and R:R ≥ {minRR.toFixed(1)}, and only while the account is
                  flat (one trade at a time). Manual analyses always wait for your click.
                </p>
              </div>
              <Switch
                checked={autoTradeOn}
                disabled={engineBusy || !engine}
                onCheckedChange={toggleAutoTrade}
                aria-label="Toggle auto-trade engine"
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Min confidence</span>
                  <span className="font-mono font-semibold tabular-nums">{minConfidence}%</span>
                </div>
                <Slider
                  value={[minConfidence]}
                  min={50}
                  max={95}
                  step={1}
                  onValueChange={(vals) => {
                    const v = vals[0] ?? minConfidence;
                    setMinConfidence(v);
                    queueEnginePatch({ minConfidence: v / 100 });
                  }}
                  aria-label="Minimum confidence for auto-trade"
                />
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Min reward : risk</span>
                  <span className="font-mono font-semibold tabular-nums">{minRR.toFixed(1)}</span>
                </div>
                <Slider
                  value={[minRR]}
                  min={1}
                  max={3}
                  step={0.1}
                  onValueChange={(vals) => {
                    const v = vals[0] ?? minRR;
                    setMinRR(v);
                    queueEnginePatch({ minRR: v });
                  }}
                  aria-label="Minimum reward-to-risk ratio for auto-trade"
                />
              </div>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              <span className="font-semibold text-foreground">Risk-based sizing:</span> every trade is sized so a
              stop-loss hit costs a fixed slice of equity — <span className="font-mono">1% base × confidence scale</span>.
              The scale rises from ×0.5 at the min-confidence slider to ×2.0 at 100% confidence, so stronger signals
              automatically take bigger (but still capped ×5 equity) positions.
            </p>
          </div>

          {/* unattended-scan brain — model / timeframe / risk profile, all persisted */}
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Auto-scan model</span>
                <span className="text-[10px] text-muted-foreground">used by auto-trade too</span>
              </div>
              <Select
                value={engineModel}
                onValueChange={(v) => {
                  setEngineModel(v);
                  void updateEngine({ model: v });
                }}
              >
                <SelectTrigger className="h-8 text-xs" aria-label="Model used by the automation engine">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="edge0-35b">edge0-35b · deep (default)</SelectItem>
                  <SelectItem value="edge0-8b">edge0-8b · fast</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                {engineModel === "edge0-35b"
                  ? "Deep reasoning — sharper verdicts, slower scans."
                  : "Fast reasoning — quicker cycles, lighter verdicts."}
              </p>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Scan timeframe</span>
              </div>
              <Select
                value={engineInterval}
                onValueChange={(v) => {
                  setEngineInterval(v as Timeframe);
                  void updateEngine({ interval: v });
                }}
              >
                <SelectTrigger className="h-8 text-xs" aria-label="Market data timeframe used by the automation engine">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIMEFRAMES.map((tf) => (
                    <SelectItem key={tf} value={tf}>
                      {tf}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                Bars fed to the model for unattended verdicts.
              </p>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Risk profile</span>
              </div>
              <Select
                value={engineRiskProfile}
                onValueChange={(v) => {
                  setEngineRiskProfile(v);
                  void updateEngine({ riskProfile: v });
                }}
              >
                <SelectTrigger className="h-8 text-xs" aria-label="Risk profile used by the automation engine">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RISK_PROFILES.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                {RISK_PROFILES.find((r) => r.value === engineRiskProfile)?.hint}
              </p>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs font-medium text-muted-foreground">Every</p>
              <div className="flex rounded-lg border p-0.5" role="group" aria-label="Scan interval">
                {SCAN_INTERVALS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      setScanMinutes(m);
                      queueEnginePatch({ scanMinutes: m });
                    }}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                      scanMinutes === m
                        ? "bg-zinc-900 text-amber-300 dark:bg-amber-500 dark:text-zinc-950"
                        : "text-muted-foreground hover:bg-muted"
                    }`}
                    aria-pressed={scanMinutes === m}
                  >
                    {m}m
                  </button>
                ))}
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5"
                onClick={() => void runScan()}
                disabled={engineBusy || scanning}
              >
                {scanning ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                ) : (
                  <Play className="size-3.5" aria-hidden />
                )}
                {scanning ? "Scanning…" : "Run now"}
              </Button>
            </div>
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">Symbols in the loop</p>
              <div className="flex flex-wrap gap-1.5">
                {watchItems.map((item) => (
                  <button
                    key={item.symbol}
                    type="button"
                    onClick={() => void toggleScan(item)}
                    className={`rounded-full border px-2.5 py-1 font-mono text-[11px] font-semibold transition-colors ${
                      item.scan
                        ? "border-amber-500 bg-amber-500/15 text-amber-700 dark:text-amber-400"
                        : "border-border text-muted-foreground hover:bg-muted"
                    }`}
                    aria-pressed={item.scan}
                    aria-label={`${item.scan ? "Remove" : "Add"} ${item.symbol} ${item.scan ? "from" : "to"} the auto-scan loop`}
                  >
                    {item.symbol}
                  </button>
                ))}
              </div>
            </div>
          </div>
            <div className="space-y-3">
              <div className="space-y-2 rounded-xl border bg-muted/30 p-3">
                {scanning ? (
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <Loader2 className="size-4 animate-spin text-amber-500" aria-hidden />
                    Engine is scanning on the server…
                  </p>
                ) : armed && countdown ? (
                  <>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Next scan in</span>
                      <span className="font-mono text-lg font-bold tabular-nums">{countdown}</span>
                    </div>
                    <Progress value={countdownPct} className="h-1.5" aria-label="Time until next scan" />
                  </>
                ) : armed ? (
                  <p className="text-sm text-muted-foreground">
                    Engine armed — the server is watching the market. Open trades are settled against live
                    prices even while this page is closed.
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Arm the engine and the <span className="font-medium">server</span> will fetch fresh{" "}
                    {engineInterval} bars for each selected symbol every {scanMinutes} minutes, ask{" "}
                    <span className="font-mono font-semibold text-foreground">{engineModel}</span> for
                    BUY / SELL / WAIT verdicts with entry, SL and TP, and file every result into the feed below.
                  </p>
                )}
                <p className="text-[11px] text-muted-foreground">
                  Everything is persisted in the database — closing the browser does{" "}
                  <span className="font-semibold">not</span> stop it.
                </p>
              </div>

              {engineEvents.length > 0 && (
                <div className="rounded-xl border p-3">
                  <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold">
                    <Bot className="size-3.5 text-amber-500" aria-hidden /> Engine activity log
                    <span className="font-normal text-muted-foreground">· stored server-side</span>
                  </p>
                  <div
                    className="custom-scrollbar max-h-44 space-y-1 overflow-y-auto pr-1"
                    aria-live="polite"
                    aria-label="Engine activity"
                  >
                    {engineEvents.map((e) => (
                      <p key={e.id} className="flex items-start gap-1.5 text-[11px] leading-snug">
                        <span
                          className={`mt-1 size-1.5 shrink-0 rounded-full ${
                            EVENT_DOT[e.type] ?? "bg-zinc-300 dark:bg-zinc-600"
                          }`}
                          aria-hidden
                        />
                        <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                          {new Date(e.createdAt).toLocaleTimeString([], { hour12: false })}
                        </span>
                        <span
                          className={
                            e.type === "open" || e.type === "close" ? "font-medium" : "text-muted-foreground"
                          }
                        >
                          {e.message}
                        </span>
                      </p>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* paper trading */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-bold">
            <Wallet className="size-4 text-amber-500" aria-hidden />
            Paper trading account
            <span className="text-xs font-normal text-muted-foreground">
              simulated fills at live Binance prices · P&amp;L stored in the database
            </span>
          </h3>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 text-muted-foreground hover:text-rose-500"
            onClick={() => void resetAccount()}
          >
            <Trash2 className="size-3.5" aria-hidden /> Reset account
          </Button>
        </div>
        <TradesPanel
          trades={trades}
          loading={tradesLoading}
          onCloseTrade={(id) => void closeTrade(id)}
          closingId={closingId}
          onDeleteClosed={() => void clearClosedTrades()}
          onSelectSymbol={(s) => setSymbol(s)}
        />
      </div>

      {/* feed */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-base">
              Signal feed
              <span className="flex gap-1.5 text-xs font-normal">
                {counts.BUY ? (
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-semibold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">
                    {counts.BUY} buy
                  </span>
                ) : null}
                {counts.SELL ? (
                  <span className="rounded-full bg-rose-100 px-2 py-0.5 font-semibold text-rose-700 dark:bg-rose-950 dark:text-rose-400">
                    {counts.SELL} sell
                  </span>
                ) : null}
                {counts.WAIT ? (
                  <span className="rounded-full bg-zinc-100 px-2 py-0.5 font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                    {counts.WAIT} wait
                  </span>
                ) : null}
              </span>
            </CardTitle>
            <div className="flex items-center gap-2">
              <Select value={feedFilter} onValueChange={setFeedFilter}>
                <SelectTrigger className="h-8 w-36 text-xs" aria-label="Filter feed by symbol">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All symbols</SelectItem>
                  {watchlist.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button size="sm" variant="ghost" className="h-8 gap-1 text-muted-foreground hover:text-rose-500" onClick={() => void clearAllSignals()}>
                <Trash2 className="size-3.5" aria-hidden /> Clear
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {feedLoading ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-12 animate-pulse rounded-lg bg-muted" />
              ))}
            </div>
          ) : filteredFeed.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No signals yet — analyze a symbol or arm the auto-scan loop.
            </p>
          ) : (
            <div className="custom-scrollbar max-h-96 space-y-1.5 overflow-y-auto pr-1">
              {filteredFeed.map((s) => {
                const meta = SIGNAL_META[s.direction];
                const open = expandedId === s.id;
                return (
                  <div key={s.id} className="rounded-lg border">
                    <button
                      type="button"
                      className="flex w-full flex-wrap items-center gap-2 p-2.5 text-left hover:bg-muted/40"
                      onClick={() => setExpandedId(open ? null : s.id)}
                      aria-expanded={open}
                    >
                      {open ? (
                        <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      ) : (
                        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      )}
                      <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-bold ${meta.badge}`}>
                        {s.direction}
                      </span>
                      <span className="font-mono text-xs font-semibold">{s.symbol}</span>
                      <span className="text-[11px] text-muted-foreground">{s.interval}</span>
                      <span className="hidden font-mono text-[11px] text-muted-foreground sm:inline">
                        E {formatPrice(s.entry)} · SL {formatPrice(s.stopLoss)} · TP {formatPrice(s.takeProfit)}
                      </span>
                      <span className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
                        <span className="font-semibold text-amber-600 dark:text-amber-400">R:R {s.rrRatio.toFixed(2)}</span>
                        <span>{Math.round(s.confidence * 100)}%</span>
                        <span className="hidden sm:inline">{s.source === "auto" ? "auto" : "manual"}</span>
                        <span>{timeAgo(s.createdAt)}</span>
                      </span>
                    </button>
                    {open && (
                      <div className="space-y-2 border-t px-3 py-2.5">
                        <p className="text-xs leading-relaxed">{s.summary}</p>
                        {s.reasons.length > 0 && (
                          <ul className="space-y-1">
                            {s.reasons.map((r, i) => (
                              <li key={i} className="text-[11px] leading-relaxed text-muted-foreground">
                                · {r}
                              </li>
                            ))}
                          </ul>
                        )}
                        {s.rationale && <p className="text-[11px] italic leading-relaxed text-muted-foreground">{s.rationale}</p>}
                        <p className="text-[10px] text-muted-foreground">
                          {s.model} · {(s.latencyMs / 1000).toFixed(1)}s · at {formatPrice(s.price)}
                          {s.risks.length > 0 ? ` · risks: ${s.risks.join(" / ")}` : ""}
                        </p>
                        <div className="flex flex-wrap items-center justify-end gap-1.5">
                          {s.symbol !== symbol && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 gap-1 text-[11px] text-muted-foreground hover:text-amber-600 dark:hover:text-amber-400"
                              onClick={() => {
                                setSymbol(s.symbol);
                                setExpandedId(null);
                              }}
                              aria-label={`View ${s.symbol} chart`}
                            >
                              <Eye className="size-3" aria-hidden /> View chart
                            </Button>
                          )}
                          {(s.direction === "BUY" || s.direction === "SELL") && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 gap-1 text-[11px] font-semibold text-emerald-700 hover:text-emerald-600 dark:text-emerald-500 dark:hover:text-emerald-400"
                              disabled={
                                simulatingId === s.id || (trades?.open.length ?? 0) > 0
                              }
                              title={
                                (trades?.open.length ?? 0) > 0
                                  ? "Single-position mode — close the open trade before simulating another"
                                  : `Simulate a ${s.direction === "BUY" ? "long" : "short"} trade of ${notional} USDT`
                              }
                              onClick={() => void simulateTrade(s.id)}
                            >
                              {simulatingId === s.id ? (
                                <Loader2 className="size-3 animate-spin" aria-hidden />
                              ) : (
                                <Zap className="size-3" aria-hidden />
                              )}
                              Simulate
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 gap-1 text-[11px] text-muted-foreground hover:text-rose-500"
                            onClick={() => void deleteSignal(s.id)}
                          >
                            <Trash2 className="size-3" aria-hidden /> Delete
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
