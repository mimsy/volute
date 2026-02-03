import React from "react";
import { Static, Box } from "ink";
import type { MoltMessage } from "../types.js";
import { ChatMessage } from "./ChatMessage.js";

export function MessageList({ messages }: { messages: MoltMessage[] }) {
  return (
    <Box flexDirection="column">
      <Static items={messages}>
        {(msg, i) => (
          <Box key={i}>
            <ChatMessage message={msg} />
          </Box>
        )}
      </Static>
    </Box>
  );
}
