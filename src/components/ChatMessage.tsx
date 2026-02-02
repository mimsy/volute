import React from "react";
import { Box, Text } from "ink";
import type { ChatMessage as ChatMessageType } from "../lib/types.js";

export function ChatMessage({ message }: { message: ChatMessageType }) {
  const isUser = message.role === "user";

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={isUser ? "cyan" : "green"}>
        {isUser ? "You" : "Molt"}
      </Text>
      {message.content && <Text>{message.content}</Text>}
      {message.toolCalls?.map((tool, i) => (
        <Text key={i} dimColor>
          ⚡ {tool.name}
        </Text>
      ))}
    </Box>
  );
}
