/** Browser-side SSE POST helper: streams named events from our API routes. */

export interface SSEHandler {
  onEvent: (event: string, data: unknown) => void;
  onError?: (err: Error) => void;
  signal?: AbortSignal;
}

export async function postSSE(url: string, body: unknown, handler: SSEHandler): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: handler.signal,
  });

  if (!res.ok || !res.body) {
    let message = `Request failed (${res.status})`;
    try {
      const j = await res.json();
      if (j?.error) message = j.error;
    } catch {
      // ignore
    }
    throw new Error(message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      let event = "message";
      let data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      try {
        handler.onEvent(event, JSON.parse(data));
      } catch {
        // skip malformed event
      }
    }
  }
}

/** Simple JSON fetch helper. */
export async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const json = (await res.json()) as T;
  if (!res.ok) {
    const maybeErr = json as unknown as { error?: string };
    throw new Error(maybeErr?.error ?? `Request failed (${res.status})`);
  }
  return json;
}
