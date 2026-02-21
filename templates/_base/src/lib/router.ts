import { formatPrefix, formatTypingSuffix } from "./format-prefix.js";
import { log, logMessage } from "./logger.js";
import {
  type BatchConfig,
  loadRoutingConfig,
  resolveRoute,
  resolveSessionConfig,
} from "./routing.js";
import { loadPrompts } from "./startup.js";
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
  typing?: string[];
};

type BatchBuffer = {
  messages: BufferedMessage[];
  debounceTimer: ReturnType<typeof setTimeout> | null;
  maxWaitTimer: ReturnType<typeof setTimeout> | null;
  sessionName: string;
  config: BatchConfig;
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

function appendTypingSuffix(
  content: VoluteContentPart[],
  typing: string[] | undefined,
): VoluteContentPart[] {
  const suffix = formatTypingSuffix(typing);
  if (!suffix) return content;
  let lastTextIdx = -1;
  for (let i = content.length - 1; i >= 0; i--) {
    if (content[i].type === "text") {
      lastTextIdx = i;
      break;
    }
  }
  if (lastTextIdx === -1) return [...content, { type: "text", text: suffix.trimStart() }];
  return content.map((part, i) => {
    if (i === lastTextIdx) return { type: "text", text: (part as { text: string }).text + suffix };
    return part;
  });
}

function prependInstructions(
  content: VoluteContentPart[],
  instructions: string | undefined,
): VoluteContentPart[] {
  if (!instructions) return content;
  const prefix = `[Session instructions: ${instructions}]\n\n`;
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

/** Check if message text matches any trigger patterns (case-insensitive substring match). */
function matchesTrigger(text: string, triggers: string[]): boolean {
  const lower = text.toLowerCase();
  return triggers.some((t) => lower.includes(t.toLowerCase()));
}

function formatInviteNotification(
  meta: ChannelMeta,
  filePath: string,
  messageText: string,
): string {
  const time = new Date().toLocaleString();
  const prompts = loadPrompts();

  const headerLines: string[] = [];
  if (meta.channel) headerLines.push(`Channel: ${meta.channel}`);
  if (meta.sender) headerLines.push(`Sender: ${meta.sender}`);
  if (meta.platform) headerLines.push(`Platform: ${meta.platform}`);
  if (meta.serverName) headerLines.push(`Server: ${meta.serverName}`);
  if (meta.channelName) headerLines.push(`Channel name: ${meta.channelName}`);
  if (meta.participants && meta.participants.length > 0)
    headerLines.push(`Participants: ${meta.participants.join(", ")}`);

  const preview = messageText.length > 200 ? `${messageText.slice(0, 200)}...` : messageText;
  const suggestedSession = sanitizeChannelPath(meta.channel ?? "unknown");
  const channel = meta.channel ?? "unknown";
  const otherCount = (meta.participantCount ?? 1) - 1;
  const batchRecommendation =
    otherCount > 1
      ? `  Session config: "${suggestedSession}": { "batch": { "debounce": 20, "maxWait": 120 } }\n(batch recommended — ${otherCount} other participants may generate frequent messages)\n`
      : "";

  const vars: Record<string, string> = {
    headers: headerLines.join("\n"),
    sender: meta.sender ?? "unknown",
    time,
    preview,
    filePath,
    channel,
    suggestedSession,
    batchRecommendation,
  };
  return prompts.channel_invite.replace(/\$\{(\w+)\}/g, (match, name) =>
    name in vars ? vars[name] : match,
  );
}

export function createRouter(options: {
  configPath?: string;
  mindHandler: HandlerResolver;
  fileHandler?: HandlerResolver;
}): Router {
  const batchBuffers = new Map<string, BatchBuffer>();
  const pendingChannels = new Set<string>();

  function flushBatch(key: string) {
    const buffer = batchBuffers.get(key);
    if (!buffer || buffer.messages.length === 0) return;

    // Clear both timers
    if (buffer.debounceTimer) clearTimeout(buffer.debounceTimer);
    if (buffer.maxWaitTimer) clearTimeout(buffer.maxWaitTimer);
    buffer.debounceTimer = null;
    buffer.maxWaitTimer = null;

    const messages = buffer.messages.splice(0);

    // Group by channel URI for header summary
    const channelCounts = new Map<string, number>();
    for (const msg of messages) {
      const uri = msg.channel ?? "unknown";
      channelCounts.set(uri, (channelCounts.get(uri) ?? 0) + 1);
    }
    const channelLabels = [...channelCounts.entries()].map(([uri, n]) => {
      const msg = messages.find((m) => m.channel === uri);
      const display = msg?.channelName
        ? `#${msg.channelName}${msg.serverName ? ` in ${msg.serverName}` : ""} (${uri})`
        : uri;
      return `${n} from ${display}`;
    });
    const summary = channelLabels.join(", ");

    const header = `[Batch: ${messages.length} message${messages.length === 1 ? "" : "s"} — ${summary}]`;
    // Include channel URI per message when batch spans multiple channels
    const multiChannel = channelCounts.size > 1;
    const body = messages
      .map((m) => {
        const prefix =
          multiChannel && m.channel
            ? `[${m.sender ?? "unknown"} in ${m.channel} — ${m.timestamp}]`
            : `[${m.sender ?? "unknown"} — ${m.timestamp}]`;
        return `${prefix}\n${m.text}`;
      })
      .join("\n\n");

    const lastTyping = messages[messages.length - 1]?.typing;
    const typingSuffix = formatTypingSuffix(lastTyping);
    let content: VoluteContentPart[] = [
      { type: "text", text: `${header}\n\n${body}${typingSuffix}` },
    ];

    // Resolve session config for instructions
    const config = options.configPath ? loadRoutingConfig(options.configPath) : {};
    const sessionConfig = resolveSessionConfig(config, buffer.sessionName);
    content = prependInstructions(content, sessionConfig.instructions);

    const messageId = generateMessageId();
    const handler = options.mindHandler(buffer.sessionName);

    // Batch flushes are fire-and-forget — no HTTP response is waiting, so listener is a noop
    try {
      handler.handle(content, { sessionName: buffer.sessionName, messageId }, () => {});
    } catch (err) {
      log("router", `error flushing batch for session ${buffer.sessionName}:`, err);
      return;
    }
    log("router", `flushed batch for session ${buffer.sessionName}: ${messages.length} messages`);
  }

  function scheduleBatchTimers(key: string) {
    const buffer = batchBuffers.get(key);
    if (!buffer) return;
    const { config } = buffer;

    // Reset debounce timer
    if (buffer.debounceTimer) clearTimeout(buffer.debounceTimer);
    if (config.debounce != null) {
      buffer.debounceTimer = setTimeout(() => flushBatch(key), config.debounce * 1000);
      buffer.debounceTimer.unref();
    }

    // Start maxWait timer if not already running
    if (!buffer.maxWaitTimer && config.maxWait != null) {
      buffer.maxWaitTimer = setTimeout(() => flushBatch(key), config.maxWait * 1000);
      buffer.maxWaitTimer.unref();
    }

    // If neither timer is configured, flush immediately (shouldn't happen in practice)
    if (config.debounce == null && config.maxWait == null) {
      flushBatch(key);
    }
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

    // Gate unmatched channels (default: gate unless explicitly disabled)
    if (!resolved.matched && config.gateUnmatched !== false) {
      const channelKey = meta.channel ?? "unknown";
      const sanitized = sanitizeChannelPath(channelKey);
      const filePath = `inbox/${sanitized}.md`;

      // Save message to file
      if (options.fileHandler) {
        const formatted = applyPrefix(content, meta);
        const fileHandler = options.fileHandler(filePath);
        fileHandler.handle(formatted, { ...meta, messageId }, noop);
      }

      // First message from this channel — send invite notification
      if (!pendingChannels.has(channelKey)) {
        pendingChannels.add(channelKey);
        const notification = formatInviteNotification(meta, filePath, text);
        const notifContent: VoluteContentPart[] = [{ type: "text", text: notification }];
        const handler = options.mindHandler("main");
        handler.handle(
          notifContent,
          {
            sessionName: "main",
            messageId: generateMessageId(),
            interrupt: true,
          },
          noop,
        );
      }

      queueMicrotask(() => safeListener({ type: "done", messageId }));
      return { messageId, unsubscribe: noop };
    }

    // Mention-mode filtering: skip messages that don't mention this mind
    if (resolved.destination === "mind" && resolved.mode === "mention") {
      const mindName = process.env.VOLUTE_MIND;
      if (mindName) {
        const escaped = mindName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = new RegExp(`\\b${escaped}\\b`, "i");
        if (!pattern.test(text)) {
          queueMicrotask(() => safeListener({ type: "done", messageId }));
          return { messageId, unsubscribe: noop };
        }
      } else {
        log("router", "VOLUTE_MIND not set — mention filtering disabled");
      }
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

    // Mind destination
    let sessionName = resolved.session;
    if (sessionName === "$new") {
      sessionName = `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }

    const sessionConfig = resolveSessionConfig(config, sessionName);

    // Batch mode: buffer the message and return immediate done
    if (sessionConfig.batch != null) {
      const batchKey = `batch:${sessionName}`;
      const batchConfig = sessionConfig.batch;

      if (!batchBuffers.has(batchKey)) {
        batchBuffers.set(batchKey, {
          messages: [],
          debounceTimer: null,
          maxWaitTimer: null,
          sessionName,
          config: batchConfig,
        });
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
        typing: meta.typing,
      });

      // Check triggers — flush immediately if matched
      if (batchConfig.triggers?.length && matchesTrigger(text, batchConfig.triggers)) {
        flushBatch(batchKey);
      } else {
        scheduleBatchTimers(batchKey);
      }

      queueMicrotask(() => safeListener({ type: "done", messageId }));
      return { messageId, unsubscribe: noop };
    }

    // Direct dispatch to mind
    const formatted = applyPrefix(content, { ...meta, sessionName });
    const withTyping = appendTypingSuffix(formatted, meta.typing);
    const withInstructions = prependInstructions(withTyping, sessionConfig.instructions);
    const handler = options.mindHandler(sessionName);
    const unsubscribe = handler.handle(
      withInstructions,
      {
        ...meta,
        sessionName,
        messageId,
        interrupt: sessionConfig.interrupt,
      },
      safeListener,
    );
    return { messageId, unsubscribe };
  }

  function close() {
    for (const [key, buffer] of batchBuffers) {
      if (buffer.debounceTimer) clearTimeout(buffer.debounceTimer);
      if (buffer.maxWaitTimer) clearTimeout(buffer.maxWaitTimer);
      flushBatch(key);
    }
    batchBuffers.clear();
  }

  return { route, close };
}
