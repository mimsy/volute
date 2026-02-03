import React, { useState, useEffect, useCallback } from "react";
import { Box, useApp } from "ink";
import type { MoltMessage } from "../types.js";
import { MessageList } from "./MessageList.js";
import { InputBar } from "./InputBar.js";

export function App({ serverUrl }: { serverUrl: string }) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<MoltMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const abortController = new AbortController();

    async function connectSSE() {
      while (!abortController.signal.aborted) {
        try {
          const res = await fetch(`${serverUrl}/events`, {
            signal: abortController.signal,
          });
          const reader = res.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop()!;

            for (const line of lines) {
              if (line.startsWith("data: ")) {
                try {
                  const msg: MoltMessage = JSON.parse(line.slice(6));
                  setIsLoading(false);
                  setMessages((prev) => [...prev, msg]);
                } catch {}
              }
            }
          }
        } catch (err: unknown) {
          if (err instanceof Error && err.name === "AbortError") return;
        }
        // Connection dropped — wait briefly then reconnect
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    connectSSE();

    return () => {
      abortController.abort();
    };
  }, [serverUrl]);

  const handleSubmit = useCallback(
    (text: string) => {
      if (text === "/quit") {
        exit();
        return;
      }

      setMessages((prev) => [
        ...prev,
        {
          role: "user",
          blocks: [{ type: "text", text }],
          timestamp: Date.now(),
        },
      ]);
      setIsLoading(true);
      fetch(`${serverUrl}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text, source: "cli" }),
      }).catch((err) => {
        console.error("Failed to send message:", err);
        setIsLoading(false);
      });
    },
    [serverUrl, exit],
  );

  return (
    <Box flexDirection="column" padding={1}>
      <MessageList messages={messages} />
      <InputBar onSubmit={handleSubmit} isLoading={isLoading} />
    </Box>
  );
}
