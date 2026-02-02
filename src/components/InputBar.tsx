import React, { useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";

export function InputBar({
  onSubmit,
  isLoading,
}: {
  onSubmit: (text: string) => void;
  isLoading: boolean;
}) {
  const [value, setValue] = useState("");

  function handleSubmit(text: string) {
    if (!text.trim()) return;
    onSubmit(text.trim());
    setValue("");
  }

  if (isLoading) {
    return (
      <Box>
        <Text>
          <Spinner type="dots" />{" "}
        </Text>
        <Text dimColor>thinking...</Text>
      </Box>
    );
  }

  return (
    <Box>
      <Text bold color="cyan">
        {"> "}
      </Text>
      <TextInput value={value} onChange={setValue} onSubmit={handleSubmit} />
    </Box>
  );
}
