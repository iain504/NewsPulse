/**
 * Always-on automation engine — a server-side singleton.
 *
 * The armed state, thresholds and scan cadence live in the database
 * (EngineConfig), so the engine keeps working as the user configured it even
 * when the browser is closed or the device is offline:
 *
 *   every scanMinutes (heartbeat every 20s):
 *     1. evaluate open paper trades against live Binance prices (SL/TP)
 *     2. if autoScan  → analyze every watchlist symbol flagged for scanning
 *        (Binance bars → indicators → LLM verdict → persisted Signal)
 *     3. if autoTrade → open a paper trade from any signal that clears the
 *        confidence AND reward:risk gates while the account is flat
 *        (single-position mode, confidence-driven risk sizing)
 *
 * Every decision lands in the EngineEvent log, which the UI replays — so the
 * history of what happened while you were away is fully auditable.
 */

import { db } from "@/lib/db";
import { isBinanceInterval, isValidSymbol, binanceRestStatus } from "@/lib/binance";
import { getCandles } from "@/lib/candle-store";
import { getTicker24hFromFeed, ensureFeedForWatchlist, feedStatus } from "@/lib/market-feed";
import { chatCompletion, streamChat } from "@/lib/edgezero";
import { extractJsonObject } from "@/lib/sentiment";
import {
  buildMarketSnapshot,
  buildPlanMessages,
  buildSignalUserPrompt,
  normalizeSignal,
  SIGNAL_SYSTEM_PROMPT,
  type RiskProfile,
  type StructuredSignal,
} from "@/lib/signal";
import { evaluateOpenTrades, openTradeFromSignal } from "@/lib/trades";
import { logEngineEvent } from "@/lib/engine-events";
import { formatPrice } from "@/lib/format";

// ---------------------------------------------------------------------------
// runtime singleton (survives HMR via globalThis)
// ---------------------------------------------------------------------------

interface EngineRuntime {
  timer: ReturnType<typeof setInterval> | null;
  /** a scan cycle is in progress */
  running: boolean;
  /** epoch ms of the next scheduled cycle (null = not scheduled) */
  nextTickAt: number | null;
  lastTickAt: number | null;
  lastTickMs: number | null;
}

const globalForEngine = globalThis as unknown as { __newspulseEngine?: EngineRuntime };

function runtime(): EngineRuntime {
  if (!globalForEngine.__newspulseEngine) {
    globalForEngine.__newspulseEngine = {
      timer: null,
      running: false,
      nextTickAt: null,
      lastTickAt: null,
      lastTickMs: null,
    };
  }
  return globalForEngine.__newspulseEngine;
}

/** How often the scheduler checks whether a cycle is due. */
const HEARTBEAT_MS = 20_000;
/** First scan happens shortly after arming so the user gets quick feedback. */
const FIRST_TICK_DELAY_MS = 10_000;
const VALID_MODELS = new Set(["edge0-35b", "edge0-8b"]);
const RISK_PROFILES = new Set(["conservative", "balanced", "aggressive"]);

// ---------------------------------------------------------------------------
// config (persisted)
// ---------------------------------------------------------------------------

export type EngineConfigRow = Awaited<ReturnType<typeof getEngineConfigRow>>;

export async function getEngineConfigRow() {
  const existing = await db.engineConfig.findUnique({ where: { id: "singleton" } });
  if (existing) return existing;
  try {
    return await db.engineConfig.create({ data: { id: "singleton" } });
  } catch {
    // raced with another request creating it
    const row = await db.engineConfig.findUnique({ where: { id: "singleton" } });
    if (!row) throw new Error("Engine config row missing.");
    return row;
  }
}

// ---------------------------------------------------------------------------
// status / control
// ---------------------------------------------------------------------------

export interface EngineStatusPayload {
  config: {
    armed: boolean;
    autoScan: boolean;
    autoTrade: boolean;
    minConfidence: number;
    minRR: number;
    scanMinutes: number;
    interval: string;
    riskProfile: string;
    model: string;
  };
  running: boolean;
  nextScanAt: string | null;
  lastTickAt: string | null;
  lastTickMs: number | null;
  openTrade: { symbol: string; direction: string; openedAt: string } | null;
  /** WebSocket market feed health (zero request weight) */
  feed: {
    connected: boolean;
    symbols: number;
    streams: number;
    lastMsgAt: string | null;
    reconnects: number;
  };
  /** governed Binance REST state (ban + weight budget) */
  rest: {
    bannedUntil: string | null;
    weightUsed: number;
    budgetPerMin: number;
  };
}

export async function getEngineStatus(): Promise<EngineStatusPayload> {
  const cfg = await getEngineConfigRow();
  const rt = runtime();
  const open = await db.trade.findFirst({
    where: { status: "OPEN" },
    orderBy: { openedAt: "desc" },
    select: { symbol: true, direction: true, openedAt: true },
  });
  const restStatus = binanceRestStatus();
  const feed = feedStatus();
  return {
    config: {
      armed: cfg.armed,
      autoScan: cfg.autoScan,
      autoTrade: cfg.autoTrade,
      minConfidence: cfg.minConfidence,
      minRR: cfg.minRR,
      scanMinutes: cfg.scanMinutes,
      interval: cfg.interval,
      riskProfile: cfg.riskProfile,
      model: cfg.model,
    },
    running: rt.running,
    nextScanAt: cfg.armed && rt.nextTickAt !== null ? new Date(rt.nextTickAt).toISOString() : null,
    lastTickAt: rt.lastTickAt !== null ? new Date(rt.lastTickAt).toISOString() : null,
    lastTickMs: rt.lastTickMs,
    openTrade: open
      ? { symbol: open.symbol, direction: open.direction, openedAt: open.openedAt.toISOString() }
      : null,
    feed: {
      connected: feed.connected,
      symbols: feed.symbols,
      streams: feed.streams,
      lastMsgAt: feed.lastMsgAt,
      reconnects: feed.reconnects,
    },
    rest: {
      bannedUntil: restStatus.bannedUntil !== null ? new Date(restStatus.bannedUntil).toISOString() : null,
      weightUsed: restStatus.usedThisMin,
      budgetPerMin: restStatus.budgetPerMin,
    },
  };
}

export interface EngineConfigPatch {
  armed?: boolean;
  autoScan?: boolean;
  autoTrade?: boolean;
  minConfidence?: number;
  minRR?: number;
  scanMinutes?: number;
  interval?: string;
  riskProfile?: string;
  model?: string;
}

/**
 * Persist a configuration change and start/stop the loop accordingly.
 * This is what makes "armed" survive restarts and browser closes — the flag
 * lives in the database, and the instrumentation hook re-arms on boot.
 */
export async function updateEngineConfig(patch: EngineConfigPatch): Promise<EngineStatusPayload> {
  const current = await getEngineConfigRow();

  const data: Partial<EngineConfigRow> = {};
  if (typeof patch.armed === "boolean") data.armed = patch.armed;
  if (typeof patch.autoScan === "boolean") data.autoScan = patch.autoScan;
  if (typeof patch.autoTrade === "boolean") data.autoTrade = patch.autoTrade;
  if (typeof patch.minConfidence === "number" && Number.isFinite(patch.minConfidence)) {
    data.minConfidence = Math.min(0.95, Math.max(0.5, patch.minConfidence));
  }
  if (typeof patch.minRR === "number" && Number.isFinite(patch.minRR)) {
    data.minRR = Math.min(3, Math.max(1, patch.minRR));
  }
  if (typeof patch.scanMinutes === "number" && Number.isFinite(patch.scanMinutes)) {
    data.scanMinutes = Math.min(60, Math.max(5, Math.round(patch.scanMinutes)));
  }
  if (typeof patch.interval === "string" && isBinanceInterval(patch.interval)) {
    data.interval = patch.interval;
  }
  if (typeof patch.riskProfile === "string" && RISK_PROFILES.has(patch.riskProfile)) {
    data.riskProfile = patch.riskProfile;
  }
  if (typeof patch.model === "string" && VALID_MODELS.has(patch.model)) {
    data.model = patch.model;
  }

  const updated = await db.engineConfig.update({ where: { id: "singleton" }, data });

  // log meaningful state transitions so the activity log tells the story
  if (updated.armed && !current.armed) {
    const parts: string[] = [];
    if (updated.autoScan) parts.push(`auto-scan every ${updated.scanMinutes} min`);
    if (updated.autoTrade) {
      parts.push(
        `auto-trade ON (confidence ≥ ${Math.round(updated.minConfidence * 100)}% · R:R ≥ ${updated.minRR.toFixed(1)})`,
      );
    }
    await logEngineEvent({
      type: "info",
      message: `Engine ARMED — ${parts.length > 0 ? parts.join(" · ") : "monitoring only (scan & auto-trade are off)"} · runs on the server, browser can be closed.`,
    });
  } else if (!updated.armed && current.armed) {
    await logEngineEvent({ type: "info", message: "Engine DISARMED — scanning and auto-trading stopped." });
  } else if (updated.armed) {
    const changes: string[] = [];
    if (data.scanMinutes !== undefined && data.scanMinutes !== current.scanMinutes) changes.push(`interval ${data.scanMinutes}m`);
    if (data.minConfidence !== undefined && data.minConfidence !== current.minConfidence) {
      changes.push(`min confidence ${Math.round(data.minConfidence * 100)}%`);
    }
    if (data.minRR !== undefined && data.minRR !== current.minRR) changes.push(`min R:R ${data.minRR.toFixed(1)}`);
    if (data.autoScan !== undefined && data.autoScan !== current.autoScan) {
      changes.push(`auto-scan ${data.autoScan ? "on" : "off"}`);
    }
    if (data.autoTrade !== undefined && data.autoTrade !== current.autoTrade) {
      changes.push(`auto-trade ${data.autoTrade ? "on" : "off"}`);
    }
    if (changes.length > 0) {
      await logEngineEvent({ type: "info", message: `Engine config updated — ${changes.join(" · ")}.` });
    }
  }

  if (updated.armed) {
    startLoop();
  } else {
    stopLoop();
  }

  return getEngineStatus();
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

/** logs the "re-armed on boot" line only once per server process */
let bootAnnounced = false;

/** Boot the engine from persisted config — called once per server start. */
export async function ensureEngine(): Promise<void> {
  try {
    // always stream the watchlist over the WebSocket feed (zero request
    // weight) so candles stay warm whether or not the engine is armed
    void ensureFeedForWatchlist();
    const cfg = await getEngineConfigRow();
    if (cfg.armed) {
      startLoop();
      if (!bootAnnounced) {
        bootAnnounced = true;
        await logEngineEvent({
          type: "info",
          message: `Server started — engine re-armed from saved config (auto-scan ${cfg.autoScan ? `every ${cfg.scanMinutes} min` : "off"} · auto-trade ${cfg.autoTrade ? "on" : "off"}).`,
        });
      }
    }
  } catch {
    // database not ready yet (e.g. first boot) — the API routes will retry
  }
}

function startLoop(): void {
  const rt = runtime();
  if (rt.timer) return; // already scheduled
  // First cycle shortly after arming, then every scanMinutes.
  rt.nextTickAt = Date.now() + FIRST_TICK_DELAY_MS;
  const timer = setInterval(() => {
    void heartbeat();
  }, HEARTBEAT_MS);
  // never keep the node process alive just for the scheduler
  timer.unref?.();
  rt.timer = timer;
}

function stopLoop(): void {
  const rt = runtime();
  if (rt.timer) {
    clearInterval(rt.timer);
    rt.timer = null;
  }
  rt.nextTickAt = null;
}

async function heartbeat(): Promise<void> {
  const rt = runtime();
  try {
    const cfg = await getEngineConfigRow();
    if (!cfg.armed) {
      stopLoop();
      return;
    }
    // settle open trades on every heartbeat — with feed prices this costs no
    // REST weight, so SL/TP fills happen within ~20s of the level being hit
    if (!rt.running && !settling) {
      settling = true;
      try {
        await evaluateOpenTrades();
      } finally {
        settling = false;
      }
    }
    if (rt.running) return;
    if (rt.nextTickAt === null) {
      rt.nextTickAt = Date.now() + cfg.scanMinutes * 60_000;
      return;
    }
    if (Date.now() >= rt.nextTickAt) {
      // schedule the next cycle up-front so cadence stays stable even if a
      // cycle overruns (LLM calls can be slow)
      rt.nextTickAt = Date.now() + cfg.scanMinutes * 60_000;
      await runEngineCycle("scheduled");
    }
  } catch {
    // heartbeat must never throw
  }
}

/** guards against overlapping SL/TP settlement (cheap, idempotent anyway) */
let settling = false;

/** Trigger one full cycle immediately (the UI "Run now" button). */
export async function triggerEngineCycle(): Promise<{ started: boolean }> {
  const rt = runtime();
  if (rt.running) return { started: false };
  // a manual cycle also re-arms the scheduler if it was not running yet
  if (runtime().timer === null) {
    const cfg = await getEngineConfigRow();
    if (cfg.armed) startLoop();
  }
  void runEngineCycle("manual").catch(() => undefined);
  return { started: true };
}

// ---------------------------------------------------------------------------
// the cycle itself
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runEngineCycle(trigger: "scheduled" | "manual"): Promise<{ started: boolean }> {
  const rt = runtime();
  if (rt.running) return { started: false };
  rt.running = true;
  const startedAt = Date.now();
  rt.lastTickAt = startedAt;

  try {
    const cfg = await getEngineConfigRow();

    // 1) settle open trades against the live market (logs close events itself)
    await evaluateOpenTrades();

    // 2) scan the watchlist
    if (!cfg.autoScan) return { started: true };

    const rows = await db.watchItem.findMany({ where: { scan: true }, orderBy: { createdAt: "asc" } });
    const list = rows.map((r) => r.symbol).filter((s) => isValidSymbol(s));
    if (list.length === 0) {
      if (trigger === "manual") {
        await logEngineEvent({
          type: "info",
          message: "Scan skipped — no watchlist symbols are flagged for scanning.",
        });
      }
      return { started: true };
    }

    await logEngineEvent({
      type: "scan",
      message: `${trigger === "manual" ? "Manual" : "Scheduled"} scan started — ${list.join(", ")} · ${cfg.interval} · ${cfg.model}`,
    });

    for (const sym of list) {
      // stop scanning the moment the engine is disarmed mid-cycle
      const live = await db.engineConfig.findUnique({ where: { id: "singleton" } });
      if (!live?.armed) break;
      try {
        await scanSymbol(sym, live);
      } catch (err) {
        await logEngineEvent({
          type: "error",
          symbol: sym,
          message: `${sym} scan failed — ${err instanceof Error ? err.message : "unknown error"}`,
        });
      }
      await sleep(1_500);
    }

    await logEngineEvent({
      type: "info",
      message: `Scan finished in ${Math.max(1, Math.round((Date.now() - startedAt) / 1000))}s.`,
    });
    return { started: true };
  } catch (err) {
    await logEngineEvent({
      type: "error",
      message: `Engine cycle failed — ${err instanceof Error ? err.message : "unknown error"}`,
    });
    return { started: true };
  } finally {
    rt.running = false;
    rt.lastTickMs = Date.now() - startedAt;
  }
}

// ---------------------------------------------------------------------------
// one symbol: market data → LLM verdict → persist → auto-trade gate
// ---------------------------------------------------------------------------

async function scanSymbol(symbol: string, cfg: EngineConfigRow): Promise<void> {
  const startedAt = Date.now();
  const interval = isBinanceInterval(cfg.interval) ? cfg.interval : "15m";

  // candles from the local cache (WebSocket-fed, bootstrapped once) + the
  // 24h stats from the miniTicker stream — zero Binance REST weight
  const { candles: klines } = await getCandles(symbol, interval, 150);
  if (klines.length < 30) {
    await logEngineEvent({
      type: "skip",
      symbol,
      message: `${symbol} skipped — only ${klines.length} cached bars so far, waiting for the feed to warm up (needs ≥30).`,
    });
    return;
  }
  const ticker = getTicker24hFromFeed(symbol);
  const snapshot = buildMarketSnapshot(symbol, interval, klines, ticker);

  // Phase 1 — structured verdict
  const raw = await chatCompletion({
    model: cfg.model,
    messages: [
      { role: "system", content: SIGNAL_SYSTEM_PROMPT },
      { role: "user", content: buildSignalUserPrompt(snapshot, cfg.riskProfile as RiskProfile) },
    ],
    temperature: 0.2,
    maxTokens: 900,
    timeoutMs: 150_000,
  });
  const parsed = extractJsonObject(raw);
  if (!parsed) throw new Error("Model did not return a valid signal JSON.");
  const signal = normalizeSignal(parsed, snapshot);

  // Phase 2 — trading-plan rationale (best effort; feeds the audit trail)
  let rationale = "";
  try {
    for await (const delta of streamChat({
      model: cfg.model,
      messages: buildPlanMessages(signal, snapshot),
      temperature: 0.5,
      maxTokens: 480,
      timeoutMs: 120_000,
    })) {
      rationale += delta;
    }
  } catch {
    // rationale is optional
  }

  const latencyMs = Date.now() - startedAt;
  const saved = await db.signal.create({
    data: {
      symbol,
      interval: cfg.interval,
      direction: signal.direction,
      confidence: signal.confidence,
      price: snapshot.lastPrice,
      entry: signal.entry,
      entryLow: signal.entryLow,
      entryHigh: signal.entryHigh,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      rrRatio: signal.rrRatio,
      timeHorizon: signal.timeHorizon,
      summary: signal.summary,
      reasons: JSON.stringify(signal.reasons),
      risks: JSON.stringify(signal.risks),
      indicators: JSON.stringify(snapshot),
      rationale,
      model: cfg.model,
      latencyMs,
      source: "auto",
    },
  });

  const confPct = Math.round(signal.confidence * 100);
  const verdict =
    signal.direction === "WAIT"
      ? `${symbol} → WAIT · conf ${confPct}% · ${signal.summary.slice(0, 120)}`
      : `${symbol} → ${signal.direction} @ ${formatPrice(signal.entry)} · SL ${formatPrice(signal.stopLoss)} · TP ${formatPrice(signal.takeProfit)} · conf ${confPct}% · R:R ${signal.rrRatio.toFixed(2)}`;
  await logEngineEvent({ type: "signal", symbol, message: verdict });

  // Phase 3 — auto-trade gate
  if (cfg.autoTrade) {
    await autoTradeGate(saved.id, signal, symbol, cfg);
  }
}

async function autoTradeGate(
  signalId: string,
  sig: StructuredSignal,
  symbol: string,
  cfg: EngineConfigRow,
): Promise<void> {
  const confPct = Math.round(sig.confidence * 100);
  const minConfPct = Math.round(cfg.minConfidence * 100);

  if (sig.direction !== "BUY" && sig.direction !== "SELL") {
    await logEngineEvent({ type: "skip", symbol, message: `${symbol} WAIT (${confPct}%) — no trade taken` });
    return;
  }
  const label = `${symbol} ${sig.direction}`;
  if (confPct < minConfPct) {
    await logEngineEvent({
      type: "skip",
      symbol,
      message: `${label} skipped — confidence ${confPct}% < ${minConfPct}%`,
    });
    return;
  }
  if (sig.rrRatio < cfg.minRR) {
    await logEngineEvent({
      type: "skip",
      symbol,
      message: `${label} skipped — R:R ${sig.rrRatio.toFixed(2)} < ${cfg.minRR.toFixed(1)}`,
    });
    return;
  }
  const open = await db.trade.findFirst({ where: { status: "OPEN" } });
  if (open) {
    await logEngineEvent({
      type: "skip",
      symbol,
      message: `${label} skipped — ${open.symbol} still open (one trade at a time)`,
    });
    return;
  }

  const res = await openTradeFromSignal({
    signalId,
    autoSize: true,
    minConfidence: cfg.minConfidence,
    source: "AUTO",
  });
  if (!res.ok) {
    await logEngineEvent({
      type: res.status === 409 ? "skip" : "error",
      symbol,
      message: `${label} ${res.status === 409 ? "skipped — position already open" : `failed — ${res.error}`}`,
    });
    return;
  }

  const riskTxt =
    res.riskAmount !== null
      ? ` · risk ${res.riskAmount.toFixed(2)} USDT${res.riskPct !== null ? ` (${res.riskPct.toFixed(2)}%)` : ""}`
      : "";
  await logEngineEvent({
    type: "open",
    symbol,
    message: `${label} opened @ ${formatPrice(res.trade.entryPrice)} · ${Math.round(res.trade.notional).toLocaleString()} USDT${riskTxt} · R:R ${sig.rrRatio.toFixed(2)} · ${confPct}%`,
  });
}
