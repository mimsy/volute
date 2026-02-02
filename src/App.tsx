import React, { useState, useEffect, useCallback } from "react";
import { Box, useApp } from "ink";
import { createAgent } from "./lib/agent.js";
import type { ChatMessage as ChatMessageType } from "./lib/types.js";
import { MessageList } from "./components/MessageList.js";
import { InputBar } from "./components/InputBar.js";

export function App({ systemPrompt }: { systemPrompt: string }) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<ChatMessageType[]>([]);
  const [streamingContent, setStreamingContent] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [agent, setAgent] = useState<ReturnType<typeof createAgent> | null>(
    null,
  );

  useEffect(() => {
    const abortController = new AbortController();
    const agentHandle = createAgent({
      systemPrompt,
      cwd: process.cwd(),
      abortController,
    });
    setAgent(agentHandle);

    (async () => {
      for await (const msg of agentHandle.stream) {
        if (msg.type === "assistant") {
          const textBlocks = msg.message.content.filter(
            (b: { type: string }) => b.type === "text",
          );
          const text = textBlocks
            .map((b: { text: string }) => b.text)
            .join("");

          const toolBlocks = msg.message.content.filter(
            (b: { type: string }) => b.type === "tool_use",
          );
          const toolCalls = toolBlocks.map(
            (b: { name: string; input: unknown }) => ({
              name: b.name,
              input: b.input,
            }),
          );

          setStreamingContent(null);
          setIsLoading(false);
          if (text || toolCalls.length > 0) {
            setMessages((prev) => [
              ...prev,
              {
                role: "assistant",
                content: text,
                toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
                timestamp: Date.now(),
              },
            ]);
          }
        } else if (msg.type === "result") {
          setIsLoading(false);
          setStreamingContent(null);
        }
      }
    })();

    return () => {
      abortController.abort();
    };
  }, [systemPrompt]);

  const handleSubmit = useCallback(
    (text: string) => {
      if (text === "/quit") {
        exit();
        return;
      }
      if (!agent) return;

      setMessages((prev) => [
        ...prev,
        { role: "user", content: text, timestamp: Date.now() },
      ]);
      setIsLoading(true);
      agent.sendMessage(text);
    },
    [agent, exit],
  );

  return (
    <Box flexDirection="column" padding={1}>
      <MessageList messages={messages} streamingContent={streamingContent} />
      <InputBar onSubmit={handleSubmit} isLoading={isLoading} />
    </Box>
  );
}
