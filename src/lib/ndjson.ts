import type { MoltEvent } from "../types.js";

export async function* readNdjson(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<MoltEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        yield JSON.parse(line) as MoltEvent;
      }
    }

    // Handle remaining buffer
    if (buffer.trim()) {
      yield JSON.parse(buffer) as MoltEvent;
    }
  } finally {
    reader.releaseLock();
  }
}
