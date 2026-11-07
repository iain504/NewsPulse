/** Shared display formatting helpers (safe for client + server). */

export function roundPrice(p: number): number {
  if (!Number.isFinite(p)) return 0;
  const abs = Math.abs(p);
  if (abs >= 10) return Math.round(p * 100) / 100;
  if (abs >= 1) return Math.round(p * 1000) / 1000;
  if (abs >= 0.01) return Math.round(p * 100000) / 100000;
  return Math.round(p * 1e8) / 1e8;
}

export function formatPrice(p: number): string {
  if (!Number.isFinite(p) || p === 0) return "—";
  const abs = Math.abs(p);
  const opts: Intl.NumberFormatOptions =
    abs >= 1000
      ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
      : abs >= 1
        ? { minimumFractionDigits: 2, maximumFractionDigits: 4 }
        : { minimumFractionDigits: 2, maximumFractionDigits: 6 };
  return new Intl.NumberFormat("en-US", opts).format(p);
}

export function formatPct(p: number, digits = 2): string {
  if (!Number.isFinite(p)) return "—";
  return `${p > 0 ? "+" : ""}${p.toFixed(digits)}%`;
}

export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(2);
}

/** Short UTC time label for chart axes. */
export function formatUtcTime(ms: number, interval: string): string {
  const d = new Date(ms);
  const hh = d.getUTCHours().toString().padStart(2, "0");
  const mm = d.getUTCMinutes().toString().padStart(2, "0");
  if (interval === "1d") {
    return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
  }
  if (interval === "4h" || interval === "1h") {
    return `${d.getUTCDate()}/${d.getUTCMonth() + 1} ${hh}:00`;
  }
  return `${hh}:${mm}`;
}

export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** Trim to at most 6 decimals, dropping trailing zeros ("1.500000" → "1.5"). */
export function formatQty(q: number): string {
  if (!Number.isFinite(q)) return "0";
  const s = q.toFixed(6).replace(/\.?0+$/, "");
  return s === "" ? "0" : s;
}

/** Signed USDT amount: "+12.50" / "-1,234.56" / "0.00". */
export function signedUsd(v: number): string {
  if (v > 0) return `+${formatPrice(v)}`;
  if (v < 0) return `-${formatPrice(Math.abs(v))}`;
  return "0.00";
}
