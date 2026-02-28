// Unified SSE connection to /api/v1/events with Last-Event-ID reconnection.
// Replaces the dual SSE (activity + per-conversation) pattern.

import type { SSEEvent } from "@volute/api/events";

type EventHandler = (event: SSEEvent) => void;

let controller: AbortController | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let lastEventId = "";
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;
const handlers = new Set<EventHandler>();

export function subscribe(handler: EventHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

function dispatch(event: SSEEvent) {
  for (const handler of handlers) {
    try {
      handler(event);
    } catch (err) {
      console.error("[connection] handler threw:", err);
    }
  }
}

function parseSSE(text: string): Array<{ id?: string; data: string }> {
  const events: Array<{ id?: string; data: string }> = [];
  let currentId: string | undefined;
  let currentData: string[] = [];

  for (const line of text.split("\n")) {
    if (line.startsWith("id:")) {
      currentId = line.slice(3).trim();
    } else if (line.startsWith("data:")) {
      currentData.push(line.slice(5).trimStart());
    } else if (line === "") {
      if (currentData.length > 0) {
        events.push({ id: currentId, data: currentData.join("\n") });
      }
      currentId = undefined;
      currentData = [];
    }
  }
  return events;
}

function startSSE() {
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;

  const url = lastEventId
    ? `/api/v1/events?since=${encodeURIComponent(lastEventId)}`
    : "/api/v1/events";

  fetch(url, { signal })
    .then(async (res) => {
      if (!res.ok || !res.body) {
        scheduleReconnect();
        return;
      }

      // Connection succeeded — reset backoff
      reconnectDelay = 1000;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE events (separated by double newline)
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";

        for (const part of parts) {
          if (!part.trim()) continue;
          const events = parseSSE(part + "\n\n");
          for (const event of events) {
            if (event.id) lastEventId = event.id;
            if (!event.data) continue;
            try {
              const parsed = JSON.parse(event.data) as SSEEvent;
              dispatch(parsed);
            } catch {
              // Ignore malformed events (e.g. keepalive pings)
            }
          }
        }
      }

      // Stream ended — reconnect
      if (!signal.aborted) {
        scheduleReconnect();
      }
    })
    .catch((err) => {
      if (err instanceof DOMException && err.name === "AbortError") return;
      scheduleReconnect();
    });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startSSE();
  }, reconnectDelay);
  // Exponential backoff
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

export function connect() {
  disconnect();
  lastEventId = "";
  reconnectDelay = 1000;
  startSSE();
}

export function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  controller?.abort();
  controller = null;
}

/** Force reconnect (e.g. after creating a new conversation). */
export function reconnect() {
  connect();
}
