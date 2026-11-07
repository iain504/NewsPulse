/**
 * Edgezero API client (OpenAI-compatible endpoint).
 * Base: https://edgezero.space-z.ai/api/v1  — Bearer "local"
 * Server-side only.
 */

const API_BASE = process.env.EDGEZERO_API_BASE ?? "https://edgezero.space-z.ai/api/v1";
const API_KEY = process.env.EDGEZERO_API_KEY ?? "local";

export interface EdgezeroModel {
  id: string;
  owned_by?: string;
  meta?: {
    params?: string;
    quant?: string;
    decode_range_tps?: number[];
    disk_gb?: number;
    base_family?: string;
    [k: string]: unknown;
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  };
}

/** List available models. */
export async function listModels(timeoutMs = 15000): Promise<EdgezeroModel[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}/models`, {
      headers: headers(),
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Models endpoint returned ${res.status}`);
    const json = (await res.json()) as { data?: EdgezeroModel[] };
    return Array.isArray(json.data) ? json.data : [];
  } finally {
    clearTimeout(t);
  }
}

/** Non-streaming chat completion → returns the assistant text content. */
export async function chatCompletion(opts: ChatOptions): Promise<string> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 120_000);
  // Link external signal if provided
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        stream: false,
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens ?? 1024,
      }),
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Chat completion failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = json.choices?.[0]?.message?.content ?? "";
    if (!content) throw new Error("Empty completion from model");
    return content;
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/** Streaming chat completion (SSE) → async generator yielding text deltas. */
export async function* streamChat(opts: ChatOptions): AsyncGenerator<string> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 120_000);
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        stream: true,
        temperature: opts.temperature ?? 0.4,
        max_tokens: opts.maxTokens ?? 800,
      }),
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (!res.ok || !res.body) {
      throw new Error(`Streaming completion failed (${res.status})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const json = JSON.parse(payload) as {
            choices?: { delta?: { content?: string } }[];
          };
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          // ignore malformed keep-alive lines
        }
      }
    }
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
