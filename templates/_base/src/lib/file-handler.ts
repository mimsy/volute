import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { log } from "./logger.js";
import type {
  HandlerMeta,
  HandlerResolver,
  Listener,
  MessageHandler,
  VoluteContentPart,
} from "./types.js";

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    log("file", `extractText received unexpected ${typeof content} instead of VoluteContentPart[]`);
    return JSON.stringify(content);
  }
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

export function createFileHandlerResolver(cwd: string): HandlerResolver {
  const resolvedCwd = resolve(cwd);

  return (filePath: string): MessageHandler => ({
    handle(content: VoluteContentPart[], meta: HandlerMeta, listener: Listener): () => void {
      const resolved = resolve(resolvedCwd, filePath);
      if (!resolved.startsWith(`${resolvedCwd}/`) && resolved !== resolvedCwd) {
        log("file", `rejected path traversal: ${filePath}`);
        queueMicrotask(() => listener({ type: "done", messageId: meta.messageId }));
        return () => {};
      }

      const text = extractText(content);
      if (text) {
        try {
          mkdirSync(dirname(resolved), { recursive: true });
          appendFileSync(resolved, `${text}\n\n`);
          log("file", `appended to ${resolved}`);
        } catch (err) {
          log("file", `failed to write ${resolved}:`, err);
        }
      }
      // Emit done asynchronously so unsubscribe is assigned before listener fires
      queueMicrotask(() => listener({ type: "done", messageId: meta.messageId }));
      return () => {};
    },
  });
}
