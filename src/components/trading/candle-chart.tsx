"use client";

import * as React from "react";

import { emaSeries } from "@/lib/indicators";
import { formatPrice, formatUtcTime } from "@/lib/format";
import type { CandleRow, ChartMarker } from "@/lib/types";

export interface ChartLevels {
  direction: "BUY" | "SELL" | "WAIT";
  entry: number;
  entryLow: number;
  entryHigh: number;
  stopLoss: number;
  takeProfit: number;
}

interface CandleChartProps {
  candles: CandleRow[];
  interval: string;
  levels?: ChartLevels | null;
  bars?: number;
  /** Historical BUY/SELL signals plotted as arrows on their bars. */
  markers?: ChartMarker[];
}

const UP = "#10b981";
const DOWN = "#f43f5e";

const VIEW_W = 860;
const VIEW_H = 380;
const PAD_L = 8;
const PAD_R = 86;
const PAD_T = 14;
const PAD_B = 46;
const VOL_H = 60;

interface PlacedMarker extends ChartMarker {
  idx: number;
  ordinal: number;
}

export function CandleChart({ candles, interval, levels, bars = 64, markers }: CandleChartProps) {
  const shown = React.useMemo(() => candles.slice(-bars), [candles, bars]);
  const ema20 = React.useMemo(() => emaSeries(shown.map((c) => c.close), 20), [shown]);
  const ema50 = React.useMemo(() => emaSeries(shown.map((c) => c.close), 50), [shown]);

  // Attach each signal marker to the bar that was open when it fired.
  const placedMarkers = React.useMemo<PlacedMarker[]>(() => {
    if (!markers || markers.length === 0 || shown.length < 2) return [];
    const ordinals = new Map<number, number>();
    const placed: PlacedMarker[] = [];
    for (const m of markers) {
      if (m.direction !== "BUY" && m.direction !== "SELL") continue;
      let idx = -1;
      for (let i = shown.length - 1; i >= 0; i--) {
        if (shown[i].openTime <= m.time) {
          idx = i;
          break;
        }
      }
      if (idx < 0) continue;
      const ordinal = ordinals.get(idx) ?? 0;
      ordinals.set(idx, ordinal + 1);
      placed.push({ ...m, idx, ordinal });
    }
    return placed;
  }, [markers, shown]);

  if (shown.length < 2) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        Not enough data to draw a chart.
      </div>
    );
  }

  const chartW = VIEW_W - PAD_L - PAD_R;
  const priceTop = PAD_T;
  const priceH = VIEW_H - PAD_T - PAD_B - VOL_H;
  const volTop = priceTop + priceH + 8;

  let lo = Math.min(...shown.map((c) => c.low));
  let hi = Math.max(...shown.map((c) => c.high));
  const pad = (hi - lo) * 0.08 || hi * 0.01;
  lo -= pad;
  hi += pad;
  const range = hi - lo || 1;

  const y = (p: number) => priceTop + (1 - (p - lo) / range) * priceH;
  const slot = chartW / shown.length;
  const bodyW = Math.max(1.5, slot * 0.62);
  const x = (i: number) => PAD_L + i * slot + slot / 2;

  const maxVol = Math.max(...shown.map((c) => c.volume)) || 1;
  const vy = (v: number) => volTop + VOL_H - (v / maxVol) * (VOL_H - 4);

  const gridPrices = [0, 0.25, 0.5, 0.75, 1].map((f) => lo + f * range);
  const timeIdx: number[] = [];
  const step = Math.max(1, Math.floor(shown.length / 5));
  for (let i = step; i < shown.length; i += step) timeIdx.push(i);

  const lastCandle = shown[shown.length - 1];
  const prevCandle = shown[shown.length - 2];
  const lastUp = lastCandle.close >= prevCandle.close;
  const lastColor = lastUp ? UP : DOWN;

  const linePoints = (series: number[]) =>
    series
      .map((v, i) => (Number.isFinite(v) ? `${x(i).toFixed(1)},${y(v).toFixed(1)}` : null))
      .filter(Boolean)
      .join(" ");

  // Level lines (clamped to the visible range if far away)
  const showLevels = levels && levels.direction !== "WAIT";
  const clampP = (p: number) => Math.min(hi - range * 0.002, Math.max(lo + range * 0.002, p));
  const tpY = showLevels ? y(clampP(levels.takeProfit)) : 0;
  const slY = showLevels ? y(clampP(levels.stopLoss)) : 0;
  const entryY = showLevels ? y(clampP(levels.entry)) : 0;
  const zoneTop = showLevels ? y(clampP(Math.max(levels.entryLow, levels.entryHigh))) : 0;
  const zoneBottom = showLevels ? y(clampP(Math.min(levels.entryLow, levels.entryHigh))) : 0;

  const lastY = y(clampP(lastCandle.close));

  return (
    <div className="w-full">
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="h-auto w-full select-none"
        role="img"
        aria-label={`${interval} candlestick chart with ${placedMarkers.length} signal marker${placedMarkers.length === 1 ? "" : "s"}`}
      >
        {/* horizontal grid + price labels */}
        {gridPrices.map((p) => (
          <g key={p}>
            <line
              x1={PAD_L}
              x2={PAD_L + chartW}
              y1={y(p)}
              y2={y(p)}
              className="stroke-border"
              strokeWidth={1}
              strokeDasharray="2 4"
            />
            <text
              x={PAD_L + chartW + 6}
              y={y(p) + 3}
              className="fill-muted-foreground text-[10px]"
            >
              {formatPrice(p)}
            </text>
          </g>
        ))}

        {/* time gridlines + labels */}
        {timeIdx.map((i) => (
          <g key={i}>
            <line
              x1={x(i)}
              x2={x(i)}
              y1={priceTop}
              y2={volTop + VOL_H}
              className="stroke-border/60"
              strokeWidth={1}
              strokeDasharray="2 5"
            />
            <text
              x={x(i)}
              y={VIEW_H - 10}
              textAnchor="middle"
              className="fill-muted-foreground text-[10px]"
            >
              {formatUtcTime(shown[i].openTime, interval)}
            </text>
          </g>
        ))}

        {/* volume bars */}
        {shown.map((c, i) => (
          <rect
            key={`v-${c.openTime}`}
            x={x(i) - bodyW / 2}
            y={vy(c.volume)}
            width={bodyW}
            height={Math.max(0.5, volTop + VOL_H - vy(c.volume))}
            fill={c.close >= c.open ? UP : DOWN}
            opacity={0.28}
          />
        ))}

        {/* entry zone band */}
        {showLevels && (
          <rect
            x={PAD_L}
            y={zoneTop}
            width={chartW}
            height={Math.max(2, zoneBottom - zoneTop)}
            fill="#f59e0b"
            opacity={0.12}
          />
        )}

        {/* candles */}
        {shown.map((c, i) => {
          const up = c.close >= c.open;
          const color = up ? UP : DOWN;
          const bodyTop = y(Math.max(c.open, c.close));
          const bodyBottom = y(Math.min(c.open, c.close));
          return (
            <g key={c.openTime}>
              <line
                x1={x(i)}
                x2={x(i)}
                y1={y(c.high)}
                y2={y(c.low)}
                stroke={color}
                strokeWidth={1}
              />
              <rect
                x={x(i) - bodyW / 2}
                y={bodyTop}
                width={bodyW}
                height={Math.max(1, bodyBottom - bodyTop)}
                fill={color}
                opacity={up ? 0.9 : 1}
              />
            </g>
          );
        })}

        {/* BUY / SELL signal markers */}
        {placedMarkers.map((m, i) => {
          const bar = shown[m.idx];
          const cx = x(m.idx);
          const isBuy = m.direction === "BUY";
          const color = isBuy ? UP : DOWN;
          const offset = m.ordinal * 13;
          const tip = isBuy
            ? y(bar.low) + 17 + offset
            : y(bar.high) - 17 - offset;
          const points = isBuy
            ? `${cx},${tip - 9} ${cx - 5},${tip} ${cx + 5},${tip}`
            : `${cx - 5},${tip} ${cx + 5},${tip} ${cx},${tip + 9}`;
          return (
            <polygon
              key={`m-${m.at}-${i}`}
              points={points}
              fill={color}
              opacity={0.95}
            >
              <title>{`${isBuy ? "BUY" : "SELL"} signal @ ${formatPrice(m.price)} · ${formatUtcTime(m.time, interval)}`}</title>
            </polygon>
          );
        })}

        {/* EMA overlays */}
        <polyline
          points={linePoints(ema20)}
          fill="none"
          stroke="#f59e0b"
          strokeWidth={1.4}
          opacity={0.85}
        />
        <polyline
          points={linePoints(ema50)}
          fill="none"
          className="stroke-zinc-400 dark:stroke-zinc-500"
          strokeWidth={1.2}
          strokeDasharray="5 4"
        />

        {/* trade levels */}
        {showLevels && (
          <>
            <line
              x1={PAD_L}
              x2={PAD_L + chartW}
              y1={tpY}
              y2={tpY}
              stroke={UP}
              strokeWidth={1.3}
              strokeDasharray="7 4"
            />
            <text x={PAD_L + chartW + 6} y={tpY + 3.5} className="text-[10px] font-semibold" fill={UP}>
              TP {formatPrice(levels.takeProfit)}
            </text>

            <line
              x1={PAD_L}
              x2={PAD_L + chartW}
              y1={entryY}
              y2={entryY}
              stroke="#f59e0b"
              strokeWidth={1.3}
              strokeDasharray="3 3"
            />
            <text x={PAD_L + chartW + 6} y={entryY + 3.5} className="text-[10px] font-semibold" fill="#f59e0b">
              EN {formatPrice(levels.entry)}
            </text>

            <line
              x1={PAD_L}
              x2={PAD_L + chartW}
              y1={slY}
              y2={slY}
              stroke={DOWN}
              strokeWidth={1.3}
              strokeDasharray="7 4"
            />
            <text x={PAD_L + chartW + 6} y={slY + 3.5} className="text-[10px] font-semibold" fill={DOWN}>
              SL {formatPrice(levels.stopLoss)}
            </text>
          </>
        )}

        {/* last price marker */}
        <line
          x1={PAD_L}
          x2={PAD_L + chartW}
          y1={lastY}
          y2={lastY}
          stroke={lastColor}
          strokeWidth={1}
          strokeDasharray="2 3"
          opacity={0.7}
        />
        <rect
          x={PAD_L + chartW + 2}
          y={lastY - 8}
          width={PAD_R - 10}
          height={16}
          rx={3}
          fill={lastColor}
        />
        <text
          x={PAD_L + chartW + 6}
          y={lastY + 3.5}
          className="text-[10px] font-bold"
          fill="#ffffff"
        >
          {formatPrice(lastCandle.close)}
        </text>

        {/* legend */}
        <g>
          <line x1={PAD_L + 4} x2={PAD_L + 22} y1={priceTop + 4} y2={priceTop + 4} stroke="#f59e0b" strokeWidth={2} />
          <text x={PAD_L + 27} y={priceTop + 7.5} className="fill-muted-foreground text-[10px]">
            EMA20
          </text>
          <line x1={PAD_L + 72} x2={PAD_L + 90} y1={priceTop + 4} y2={priceTop + 4} className="stroke-zinc-400" strokeWidth={2} strokeDasharray="4 3" />
          <text x={PAD_L + 95} y={priceTop + 7.5} className="fill-muted-foreground text-[10px]">
            EMA50
          </text>
          <text x={PAD_L + 146} y={priceTop + 8.5} fill={UP} className="text-[10px] font-bold">
            ▲ BUY
          </text>
          <text x={PAD_L + 196} y={priceTop + 8.5} fill={DOWN} className="text-[10px] font-bold">
            ▼ SELL
          </text>
        </g>
      </svg>
    </div>
  );
}
