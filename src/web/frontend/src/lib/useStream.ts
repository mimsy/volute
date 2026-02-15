import { useCallback, useRef } from "react";
import type { VoluteEvent } from "./api";

export function useChatSend(name: string, onEvent: (event: VoluteEvent) => void) {
  const send = useCallback(
    async (
      message: string,
      conversationId?: string,
      images?: Array<{ media_type: string; data: string }>,
      agentName?: string,
    ) => {
      const targetName = agentName || name;
      const res = await fetch(`/api/agents/${targetName}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: message || undefined,
          conversationId,
          images: images && images.length > 0 ? images : undefined,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error ?? `Chat request failed: ${res.status}`);
      }

      const data = (await res.json()) as { ok: boolean; conversationId: string };
      // Emit meta event so Chat component knows the conversationId
      onEvent({ type: "meta", conversationId: data.conversationId });
      // Emit done — the actual messages will arrive via the SSE subscription
      onEvent({ type: "done" });
    },
    [name, onEvent],
  );

  return { send };
}

export function useLogStream(
  name: string,
  onLine: (line: string) => void,
): { start: () => void; stop: () => void } {
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    fetch(`/api/agents/${name}/logs`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6);
            if (data) onLine(data);
          }
        }
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.warn("[logs] stream error:", err);
      });
  }, [name, onLine]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { start, stop };
}

export function useSystemLogStream(onLine: (line: string) => void): {
  start: () => void;
  stop: () => void;
} {
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    fetch("/api/system/logs", { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6);
            if (data) onLine(data);
          }
        }
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.warn("[system-logs] stream error:", err);
      });
  }, [onLine]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { start, stop };
}
