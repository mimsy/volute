import React from "react";
import { Static, Box } from "ink";
import type { ChatMessage as ChatMessageType } from "../lib/types.js";
import { ChatMessage } from "./ChatMessage.js";

export function MessageList({
  messages,
  streamingContent,
}: {
  messages: ChatMessageType[];
  streamingContent: string | null;
}) {
  return (
    <Box flexDirection="column">
      <Static items={messages}>
        {(msg, i) => (
          <Box key={i}>
            <ChatMessage message={msg} />
          </Box>
        )}
      </Static>
      {streamingContent !== null && (
        <Box flexDirection="column" marginBottom={1}>
          <ChatMessage
            message={{
              role: "assistant",
              content: streamingContent,
              timestamp: Date.now(),
            }}
          />
        </Box>
      )}
    </Box>
  );
}
