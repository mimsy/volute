import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "./logger.js";
import type {
  ChannelMeta,
  HandlerResolver,
  Listener,
  MessageHandler,
  VoluteContentPart,
} from "./types.js";

function extractText(content: VoluteContentPart[]): string {
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

function createFileHandler(filePath: string): MessageHandler {
  return {
    handle(
      content: VoluteContentPart[],
      meta: ChannelMeta & { messageId: string },
      listener: Listener,
    ): () => void {
      const text = extractText(content);
      if (text) {
        mkdirSync(dirname(filePath), { recursive: true });
        appendFileSync(filePath, `${text}\n\n`);
        log("file", `appended to ${filePath}`);
      }
      // Emit done asynchronously so unsubscribe is assigned before listener fires
      queueMicrotask(() => listener({ type: "done", messageId: meta.messageId }));
      return () => {};
    },
  };
}

export function createFileHandlerResolver(): HandlerResolver {
  const handlers = new Map<string, MessageHandler>();
  return (filePath: string) => {
    let handler = handlers.get(filePath);
    if (!handler) {
      handler = createFileHandler(filePath);
      handlers.set(filePath, handler);
    }
    return handler;
  };
}
