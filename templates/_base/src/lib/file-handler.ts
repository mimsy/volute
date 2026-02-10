import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "./logger.js";
import type {
  HandlerMeta,
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

export function createFileHandlerResolver(): HandlerResolver {
  return (filePath: string): MessageHandler => ({
    handle(content: VoluteContentPart[], meta: HandlerMeta, listener: Listener): () => void {
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
  });
}
