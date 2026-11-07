"use client";

import * as React from "react";
import { motion, useSpring } from "framer-motion";
import { SENTIMENT_META, type SentimentLabel } from "@/lib/types";

interface SentimentGaugeProps {
  /** Sentiment score in the range -1..1 */
  score: number;
  sentiment: SentimentLabel;
  /** Width of the gauge in px (default 260) */
  size?: number;
}

const ARC_PATH = "M 20 100 A 80 80 0 0 1 180 100";

/** Semicircular -1..1 sentiment gauge with an animated spring needle. */
export function SentimentGauge({ score, sentiment, size = 260 }: SentimentGaugeProps) {
  const meta = SENTIMENT_META[sentiment];
  const clamped = Math.max(-1, Math.min(1, Number.isFinite(score) ? score : 0));
  const scoreText = `${clamped > 0 ? "+" : ""}${clamped.toFixed(2)}`;

  // Needle animates from straight up (0deg) to score * 90deg with a spring.
  const angle = useSpring(0, { stiffness: 50, damping: 13, mass: 0.9 });
  React.useEffect(() => {
    angle.set(clamped * 90);
  }, [angle, clamped]);

  // Tick marks at scores -1, -0.5, 0, 0.5, 1
  const ticks = [-1, -0.5, 0, 0.5, 1].map((s) => {
    const rad = (s * 90 * Math.PI) / 180;
    const sin = Math.sin(rad);
    const cos = Math.cos(rad);
    return {
      x1: 100 + 88 * sin,
      y1: 100 - 88 * cos,
      x2: 100 + 95 * sin,
      y2: 100 - 95 * cos,
    };
  });

  return (
    <div className="flex flex-col items-center" style={{ width: size }}>
      <svg
        viewBox="0 0 200 120"
        width={size}
        height={size * 0.6}
        role="img"
        aria-label={`Sentiment gauge: ${meta.label} (${scoreText})`}
      >
        <defs>
          <linearGradient id="newspulse-gauge-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#f43f5e" />
            <stop offset="28%" stopColor="#f43f5e" />
            <stop offset="42%" stopColor="#a1a1aa" />
            <stop offset="58%" stopColor="#a1a1aa" />
            <stop offset="72%" stopColor="#10b981" />
            <stop offset="100%" stopColor="#10b981" />
          </linearGradient>
        </defs>

        {/* Faint track behind the gradient arc */}
        <path
          d={ARC_PATH}
          fill="none"
          stroke="#e4e4e7"
          className="dark:stroke-zinc-800"
          strokeWidth={14}
          strokeLinecap="round"
        />
        {/* Colored sentiment arc: rose (negative) → zinc (neutral) → emerald (positive) */}
        <path
          d={ARC_PATH}
          fill="none"
          stroke="url(#newspulse-gauge-gradient)"
          strokeWidth={14}
          strokeLinecap="round"
        />

        {/* Scale ticks */}
        {ticks.map((t, i) => (
          <line
            key={i}
            x1={t.x1}
            y1={t.y1}
            x2={t.x2}
            y2={t.y2}
            stroke="#a1a1aa"
            strokeWidth={2}
            strokeLinecap="round"
            opacity={0.6}
          />
        ))}

        {/* Spring-animated needle */}
        <motion.g
          style={{
            rotate: angle,
            transformOrigin: "100px 100px",
            transformBox: "view-box",
          }}
        >
          <line
            x1={100}
            y1={100}
            x2={100}
            y2={40}
            stroke={meta.hex}
            strokeWidth={5}
            strokeLinecap="round"
          />
          <circle cx={100} cy={100} r={7.5} fill={meta.hex} />
          <circle cx={100} cy={100} r={2.75} fill="var(--background)" />
        </motion.g>
      </svg>

      <div className="-mt-1 flex items-baseline gap-2">
        <span className={`text-4xl font-bold tabular-nums ${meta.text}`}>{scoreText}</span>
        <span className="text-sm font-medium text-muted-foreground">{meta.label}</span>
      </div>
    </div>
  );
}
