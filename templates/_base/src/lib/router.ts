import { formatPrefix } from "./format-prefix.js";
import { log, logMessage } from "./logger.js";
import { loadSessionConfig, resolveRoute } from "./sessions.js";
import type { ChannelMeta, HandlerResolver, Listener, VoluteContentPart } from "./types.js";

export type Router = {
  route(
    content: VoluteContentPart[],
    meta: ChannelMeta,
    listener?: Listener,
  ): { messageId: string; unsubscribe: () => void };
  close(): void;
};

type BufferedMessage = {
  text: string;
  sender?: string;
  channel?: string;
  channelName?: string;
  guildName?: string;
  timestamp: string;
};

type BatchBuffer = {
  messages: BufferedMessage[];
  timer: ReturnType<typeof setInterval>;
  sessionName: string;
};

function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function applyPrefix(content: VoluteContentPart[], meta: ChannelMeta): VoluteContentPart[] {
  const time = new Date().toLocaleString();
  const prefix = formatPrefix(meta, time);
  if (!prefix) return content;

  const firstTextIdx = content.findIndex((p) => p.type === "text");
  if (firstTextIdx === -1) {
    return [{ type: "text", text: prefix.trimEnd() }, ...content];
  }

  return content.map((part, i) => {
    if (i === firstTextIdx) {
      return { type: "text" as const, text: prefix + (part as { text: string }).text };
    }
    return part;
  });
}

export function createRouter(options: {
  configPath?: string;
  agentHandler: HandlerResolver;
  fileHandler?: HandlerResolver;
}): Router {
  const batchBuffers = new Map<string, BatchBuffer>();

  function flushBatch(key: string) {
    const buffer = batchBuffers.get(key);
    if (!buffer || buffer.messages.length === 0) return;

    const messages = buffer.messages.splice(0);

    // Group by channel for header summary
    const channelCounts = new Map<string, number>();
    for (const msg of messages) {
      const label = msg.channelName
        ? `#${msg.channelName}${msg.guildName ? ` in ${msg.guildName}` : ""}`
        : (msg.channel ?? "unknown");
      channelCounts.set(label, (channelCounts.get(label) ?? 0) + 1);
    }
    const summary = [...channelCounts.entries()].map(([ch, n]) => `${n} from ${ch}`).join(", ");

    const header = `[Batch: ${messages.length} message${messages.length === 1 ? "" : "s"} — ${summary}]`;
    const body = messages
      .map((m) => `[${m.sender ?? "unknown"} — ${m.timestamp}]\n${m.text}`)
      .join("\n\n");

    const content: VoluteContentPart[] = [{ type: "text", text: `${header}\n\n${body}` }];
    const messageId = generateMessageId();
    const handler = options.agentHandler(buffer.sessionName);

    // Batch flushes are fire-and-forget — no HTTP response is waiting, so listener is a noop
    try {
      handler.handle(content, { sessionName: buffer.sessionName, messageId }, () => {});
    } catch (err) {
      log("router", `error flushing batch for session ${buffer.sessionName}:`, err);
      return;
    }
    log("router", `flushed batch for session ${buffer.sessionName}: ${messages.length} messages`);
  }

  function route(
    content: VoluteContentPart[],
    meta: ChannelMeta,
    listener?: Listener,
  ): { messageId: string; unsubscribe: () => void } {
    // Log incoming message
    const text = content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join(" ");
    logMessage("in", text, meta.channel);

    // Resolve route from config (re-read on each request for hot-reload)
    const config = options.configPath ? loadSessionConfig(options.configPath) : {};
    const resolved = resolveRoute(config, { channel: meta.channel, sender: meta.sender });

    const messageId = generateMessageId();
    const noop = () => {};
    const safeListener = listener ?? noop;

    // File destination
    if (resolved.destination === "file") {
      if (options.fileHandler) {
        const formatted = applyPrefix(content, meta);
        const handler = options.fileHandler(resolved.path);
        const unsubscribe = handler.handle(formatted, { ...meta, messageId }, safeListener);
        return { messageId, unsubscribe };
      }
      // No file handler configured — emit done and discard
      log("router", `no file handler configured — discarding file-destined message`);
      queueMicrotask(() => safeListener({ type: "done", messageId }));
      return { messageId, unsubscribe: noop };
    }

    // Agent destination
    let sessionName = resolved.session;
    if (sessionName === "$new") {
      sessionName = `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }

    // Batch mode: buffer the message and return immediate done
    if (resolved.batch != null) {
      const batchKey = `batch:${sessionName}`;

      if (!batchBuffers.has(batchKey)) {
        const timer = setInterval(() => flushBatch(batchKey), resolved.batch * 60 * 1000);
        timer.unref();
        batchBuffers.set(batchKey, { messages: [], timer, sessionName });
      }

      batchBuffers.get(batchKey)!.messages.push({
        text,
        sender: meta.sender,
        channel: meta.channel,
        channelName: meta.channelName,
        guildName: meta.guildName,
        timestamp: new Date().toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
        }),
      });

      queueMicrotask(() => safeListener({ type: "done", messageId }));
      return { messageId, unsubscribe: noop };
    }

    // Direct dispatch to agent
    const formatted = applyPrefix(content, { ...meta, sessionName });
    const handler = options.agentHandler(sessionName);
    const unsubscribe = handler.handle(
      formatted,
      { ...meta, sessionName, messageId, interrupt: resolved.interrupt },
      safeListener,
    );
    return { messageId, unsubscribe };
  }

  function close() {
    for (const [key, buffer] of batchBuffers) {
      clearInterval(buffer.timer);
      flushBatch(key);
    }
    batchBuffers.clear();
  }

  return { route, close };
}
