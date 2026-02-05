import { useRef, useCallback } from "react";
import type { MoltEvent } from "./api";

export function useChatStream(
  name: string,
  onEvent: (event: MoltEvent) => void,
) {
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(
    async (message: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const res = await fetch(`/api/agents/${name}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) throw new Error("Chat request failed");

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
          const json = line.slice(6);
          if (!json) continue;
          try {
            const event = JSON.parse(json) as MoltEvent;
            onEvent(event);
          } catch {
            // skip invalid
          }
        }
      }
    },
    [name, onEvent],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { send, stop };
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
      .catch(() => {
        // Stream ended or aborted
      });
  }, [name, onLine]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { start, stop };
}
