import type { MoltEvent } from "../types.js";
import log from "./logger.js";

export async function* readNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator<MoltEvent> {
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
        try {
          yield JSON.parse(line) as MoltEvent;
        } catch {
          log.warn("ndjson: skipping invalid line", { line: line.slice(0, 100) });
        }
      }
    }

    // Handle remaining buffer
    if (buffer.trim()) {
      try {
        yield JSON.parse(buffer) as MoltEvent;
      } catch {
        log.warn("ndjson: skipping invalid line", { line: buffer.slice(0, 100) });
      }
    }
  } finally {
    reader.releaseLock();
  }
}
