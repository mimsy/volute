import React from "react";
import { Box, Text } from "ink";
import type { MoltMessage, MoltBlock } from "../types.js";

function renderBlock(block: MoltBlock, i: number) {
  switch (block.type) {
    case "text":
      return <Text key={i}>{block.text}</Text>;
    case "thinking":
      return (
        <Text key={i} dimColor italic>
          {block.text}
        </Text>
      );
    case "tool_use":
      return (
        <Text key={i} dimColor>
          ⚡ {block.name}
        </Text>
      );
    case "tool_result":
      return block.is_error ? (
        <Text key={i} color="red">
          ✗ {block.output}
        </Text>
      ) : (
        <Text key={i} dimColor>
          ↪ {block.output}
        </Text>
      );
    case "image":
      return (
        <Text key={i} dimColor>
          [image: {block.media_type}]
        </Text>
      );
  }
}

export function ChatMessage({ message }: { message: MoltMessage }) {
  const isUser = message.role === "user";

  if (message.done) return null;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={isUser ? "cyan" : "green"}>
        {isUser ? "You" : "Agent"}
      </Text>
      {message.blocks.map((block, i) => renderBlock(block, i))}
    </Box>
  );
}
