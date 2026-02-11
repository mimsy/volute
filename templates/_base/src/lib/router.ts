import { formatPrefix } from "./format-prefix.js";
import { log, logMessage } from "./logger.js";
import { loadRoutingConfig, resolveRoute } from "./routing.js";
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
  serverName?: string;
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

function sanitizeChannelPath(channel: string): string {
  return channel
    .replace(/[/\\:]/g, "-")
    .replace(/\.\./g, "-")
    .replace(/\0/g, "")
    .slice(0, 100);
}

function formatInviteNotification(
  meta: ChannelMeta,
  filePath: string,
  messageText: string,
): string {
  const time = new Date().toLocaleString();
  const lines = ["[Channel Invite]"];
  if (meta.channel) lines.push(`Channel: ${meta.channel}`);
  if (meta.sender) lines.push(`Sender: ${meta.sender}`);
  if (meta.platform) lines.push(`Platform: ${meta.platform}`);
  if (meta.serverName) lines.push(`Server: ${meta.serverName}`);
  if (meta.channelName) lines.push(`Channel name: ${meta.channelName}`);
  if (meta.participants && meta.participants.length > 0)
    lines.push(`Participants: ${meta.participants.join(", ")}`);
  lines.push("");
  const preview = messageText.length > 200 ? `${messageText.slice(0, 200)}...` : messageText;
  lines.push(`[${meta.sender ?? "unknown"} — ${time}]`);
  lines.push(preview);
  lines.push("");
  lines.push(`Further messages will be saved to ${filePath}`);
  lines.push("");
  lines.push("To accept, add a routing rule to .config/routes.json:");
  const suggestedSession = sanitizeChannelPath(meta.channel ?? "unknown");
  const otherCount = (meta.participantCount ?? 1) - 1;
  if (otherCount > 1) {
    lines.push(`  { "channel": "${meta.channel}", "session": "${suggestedSession}", "batch": 5 }`);
    lines.push(
      `(batch recommended — ${otherCount} other participants may generate frequent messages)`,
    );
  } else {
    lines.push(`  { "channel": "${meta.channel}", "session": "${suggestedSession}" }`);
  }
  lines.push(`To respond, use: volute channel send ${meta.channel} "your message"`);
  lines.push(`To reject, delete ${filePath}`);
  return lines.join("\n");
}

export function createRouter(options: {
  configPath?: string;
  agentHandler: HandlerResolver;
  fileHandler?: HandlerResolver;
}): Router {
  const batchBuffers = new Map<string, BatchBuffer>();
  const pendingChannels = new Set<string>();

  function flushBatch(key: string) {
    const buffer = batchBuffers.get(key);
    if (!buffer || buffer.messages.length === 0) return;

    const messages = buffer.messages.splice(0);

    // Group by channel for header summary
    const channelCounts = new Map<string, number>();
    for (const msg of messages) {
      const label = msg.channelName
        ? `#${msg.channelName}${msg.serverName ? ` in ${msg.serverName}` : ""}`
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
    const config = options.configPath ? loadRoutingConfig(options.configPath) : {};
    const resolved = resolveRoute(config, {
      channel: meta.channel,
      sender: meta.sender,
      isDM: meta.isDM,
      participantCount: meta.participantCount,
    });

    const messageId = generateMessageId();
    const noop = () => {};
    const safeListener = listener ?? noop;

    // Gate unmatched channels
    if (!resolved.matched && config.gateUnmatched) {
      const channelKey = meta.channel ?? "unknown";
      const sanitized = sanitizeChannelPath(channelKey);
      const filePath = `inbox/${sanitized}.md`;

      if (!pendingChannels.has(channelKey)) {
        pendingChannels.add(channelKey);

        // Send invite notification to main session
        const notification = formatInviteNotification(meta, filePath, text);
        const notifContent: VoluteContentPart[] = [{ type: "text", text: notification }];
        const handler = options.agentHandler("main");
        const unsubscribe = handler.handle(
          notifContent,
          { sessionName: "main", messageId: generateMessageId(), interrupt: true },
          safeListener,
        );

        // Save original message to file
        if (options.fileHandler) {
          const formatted = applyPrefix(content, meta);
          const fileHandler = options.fileHandler(filePath);
          fileHandler.handle(formatted, { ...meta, messageId }, noop);
        }

        return { messageId, unsubscribe };
      } else {
        // Already pending — just append to file
        if (options.fileHandler) {
          const formatted = applyPrefix(content, meta);
          const fileHandler = options.fileHandler(filePath);
          fileHandler.handle(formatted, { ...meta, messageId }, noop);
        }
        queueMicrotask(() => safeListener({ type: "done", messageId }));
      }
      return { messageId, unsubscribe: noop };
    }

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
        serverName: meta.serverName,
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
