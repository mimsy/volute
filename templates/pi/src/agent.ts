import type { ImageContent } from "@mariozechner/pi-ai";
import { createPiSessionManager } from "./lib/agent-sessions.js";
import { formatPrefix } from "./lib/format-prefix.js";
import { logMessage } from "./lib/logger.js";
import {
  type ChannelMeta,
  INTERACTIVE_CHANNELS,
  type Listener,
  type VoluteContentPart,
} from "./lib/types.js";

export function createAgent(options: {
  systemPrompt: string;
  cwd: string;
  model?: string;
  compactionMessage?: string;
}) {
  const { getOrCreateSession, interruptSession } = createPiSessionManager(options);

  function sendMessage(content: string | VoluteContentPart[], meta?: ChannelMeta) {
    const raw =
      typeof content === "string"
        ? content
        : content
            .filter((p) => p.type === "text")
            .map((p) => (p as { text: string }).text)
            .join("\n");
    logMessage("in", raw, meta?.channel);

    const sessionName = meta?.sessionName ?? "main";
    const session = getOrCreateSession(sessionName);

    // Build context prefix from channel metadata
    const prefix = formatPrefix(meta, new Date().toLocaleString());
    const text = prefix + raw;

    // Convert image parts to pi-ai ImageContent format
    const images: ImageContent[] | undefined =
      typeof content === "string"
        ? undefined
        : content
            .filter((p) => p.type === "image")
            .map((p) => ({ type: "image" as const, mimeType: p.media_type, data: p.data }));

    const opts = images?.length ? { images } : {};

    // Track messageId for this turn (must be pushed before prompt)
    session.messageIds.push(meta?.messageId);

    // Fire-and-forget: await session ready then prompt
    (async () => {
      await session.ready;
      if (session.agentSession!.isStreaming) {
        if (INTERACTIVE_CHANNELS.has(meta?.channel ?? "")) {
          interruptSession(sessionName);
          session.agentSession!.prompt(text, { streamingBehavior: "steer", ...opts });
        } else {
          session.agentSession!.prompt(text, { streamingBehavior: "followUp", ...opts });
        }
      } else {
        session.agentSession!.prompt(text, opts);
      }
    })();
  }

  function onMessage(listener: Listener, sessionName?: string): () => void {
    const name = sessionName ?? "main";
    const session = getOrCreateSession(name);
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  }

  return { sendMessage, onMessage };
}
