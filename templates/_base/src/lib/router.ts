import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  compactTime,
  compactTimestamp,
  formatEventPrefix,
  formatPrefix,
  formatTypingSuffix,
} from "./format-prefix.js";
import { log, warn } from "./logger.js";
import type { ChannelMeta, HandlerResolver, Listener, VoluteContentPart } from "./types.js";

/**
 * Message formatting for pre-routed deliveries.
 *
 * The daemon delivery manager is the sole router: it parses each mind's
 * `home/.config/routes.json`, matches rules, resolves the session, filters
 * mentions, gates unrecognized channels, and buffers batches (see
 * `packages/daemon/src/lib/delivery/`). By the time a message reaches this
 * template it has already been routed to a named session — the mind only
 * formats it (channel/sender/time prefix, typing suffix, session reply
 * instructions) and hands it to its session handler. `.config/routes.json`
 * stays mind-owned; only the resolution *engine* lives daemon-side.
 */

/** Shape of a single message in a batch payload (subset of daemon DeliveryPayload). */
export type BatchMessage = {
  sender?: string | null;
  content: unknown;
};

export type Router = {
  /** Direct dispatch to a pre-routed session (daemon has already resolved the route). */
  dispatch(
    content: VoluteContentPart[],
    session: string,
    meta: ChannelMeta,
    listener?: Listener,
  ): { messageId: string; unsubscribe: () => void };
  dispatchBatch(
    batch: { channels: Record<string, BatchMessage[]> },
    session: string,
    meta: ChannelMeta,
  ): void;
};

/** Per-session formatting config (subset of `.config/routes.json` `threads` entries). */
export type SessionConfig = {
  interrupt?: boolean;
  instructions?: string;
  replyInstructions?: "once" | "always" | "never";
};

type ResolvedSessionConfig = {
  interrupt: boolean;
  instructions?: string;
  replyInstructions: "once" | "always" | "never";
};

type RoutingConfig = {
  threads?: Record<string, SessionConfig>;
};

/**
 * Load the `threads` formatting config from `.config/routes.json`. Routing rules
 * (channel/sender matching, gating) are resolved by the daemon and ignored here;
 * a bare rules array carries no thread config.
 */
function loadRoutingConfig(configPath: string): RoutingConfig {
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
    if (Array.isArray(parsed)) return {};
    return parsed;
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      log("router", `failed to load ${configPath}:`, err);
    }
    return {};
  }
}

/**
 * Match a glob-like pattern against a string.
 * Supports only `*` as wildcard (matches any sequence of characters).
 */
function globMatch(pattern: string, value: string): boolean {
  const regex = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${regex}$`).test(value);
}

/**
 * Resolve session formatting config by matching the session name against
 * glob-pattern keys in `config.threads`. First match wins; defaults otherwise.
 */
function resolveSessionConfig(config: RoutingConfig, sessionName: string): ResolvedSessionConfig {
  const defaults: ResolvedSessionConfig = { interrupt: false, replyInstructions: "once" };
  if (!config.threads) return defaults;

  for (const [pattern, sessionConfig] of Object.entries(config.threads)) {
    if (globMatch(pattern, sessionName)) {
      return {
        interrupt: sessionConfig.interrupt ?? false,
        instructions: sessionConfig.instructions,
        replyInstructions: sessionConfig.replyInstructions ?? "once",
      };
    }
  }

  return defaults;
}

function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function applyPrefix(content: VoluteContentPart[], meta: ChannelMeta): VoluteContentPart[] {
  const time = compactTimestamp();
  // System-event turns get the fenced `=== System event: … ===` heading — no sender/DM framing.
  const prefix = meta.isEvent
    ? formatEventPrefix(meta.eventLabel ?? "Event", meta.eventAt)
    : formatPrefix(meta, time);
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

export function createRouter(options: {
  configPath?: string;
  mindHandler: HandlerResolver;
}): Router {
  const instructedSessions = new Set<string>();

  /** Prepend session instructions only on the first message per session. */
  function prependInstructionsOnce(
    content: VoluteContentPart[],
    instructions: string | undefined,
    sessionName: string,
  ): VoluteContentPart[] {
    if (!instructions) return content;
    // Ephemeral $new sessions get a unique name dispatched exactly once, so we
    // always prepend and never track them — tracking would leak an entry per message.
    if (sessionName.startsWith("new-")) return prependInstructions(content, instructions);
    if (instructedSessions.has(sessionName)) return content;
    instructedSessions.add(sessionName);
    return prependInstructions(content, instructions);
  }

  /**
   * Direct dispatch to a pre-routed session. The daemon delivery manager has already
   * resolved the route and session — just format and send.
   */
  function dispatch(
    content: VoluteContentPart[],
    session: string,
    meta: ChannelMeta,
    listener?: Listener,
  ): { messageId: string; unsubscribe: () => void } {
    const messageId = generateMessageId();

    // Expose session to child processes (daemon-client reads this for X-Volute-Thread)
    process.env.VOLUTE_SESSION = session;
    // Also write to file for sandbox environments where env vars don't propagate
    try {
      const mindDir = process.env.VOLUTE_MIND_DIR;
      if (mindDir) {
        const sessionFile = resolve(mindDir, ".mind", "current-session");
        mkdirSync(resolve(mindDir, ".mind"), { recursive: true });
        writeFileSync(sessionFile, session, "utf-8");
      }
    } catch (err) {
      warn("router", `failed to write session file: ${err}`);
    }

    // Apply formatting
    const formatted = applyPrefix(content, { ...meta, sessionName: session });
    const withTyping = appendTypingSuffix(formatted, meta.typing);

    // Resolve session config for instructions
    const config = options.configPath ? loadRoutingConfig(options.configPath) : {};
    const sessionConfig = resolveSessionConfig(config, session);
    const withInstructions = prependInstructionsOnce(
      withTyping,
      sessionConfig.instructions,
      session,
    );

    const handler = options.mindHandler(session);
    const interrupt = meta.interrupt ?? sessionConfig.interrupt;
    const unsubscribe = handler.handle(
      withInstructions,
      {
        ...meta,
        sessionName: session,
        messageId,
        interrupt,
        replyInstructions: sessionConfig.replyInstructions,
      },
      listener,
    );
    return { messageId, unsubscribe };
  }

  /**
   * Handle a pre-batched payload from the daemon delivery manager.
   * Formats messages grouped by channel into a single SDK message.
   */
  function dispatchBatch(
    batch: { channels: Record<string, BatchMessage[]> },
    session: string,
    _meta: ChannelMeta,
  ): void {
    const allMessages: { channel: string; payload: BatchMessage }[] = [];
    for (const [channel, messages] of Object.entries(batch.channels)) {
      for (const msg of messages) {
        allMessages.push({ channel, payload: msg });
      }
    }

    if (allMessages.length === 0) return;

    // Build channel summary
    const channelCounts = new Map<string, number>();
    for (const msg of allMessages) {
      channelCounts.set(msg.channel, (channelCounts.get(msg.channel) ?? 0) + 1);
    }
    let header: string;
    if (channelCounts.size === 1) {
      const [ch] = [...channelCounts.keys()];
      header = `[Batch: ${allMessages.length} message${allMessages.length === 1 ? "" : "s"} from ${ch}]`;
    } else {
      const channelLabels = [...channelCounts.entries()].map(([ch, n]) => `${n} from ${ch}`);
      header = `[Batch: ${allMessages.length} messages — ${channelLabels.join(", ")}]`;
    }
    const multiChannel = channelCounts.size > 1;

    const body = allMessages
      .map((m) => {
        const sender = m.payload.sender;
        const text =
          typeof m.payload.content === "string"
            ? m.payload.content
            : Array.isArray(m.payload.content)
              ? (m.payload.content as { type: string; text?: string }[])
                  .filter((p) => p.type === "text" && p.text)
                  .map((p) => p.text)
                  .join("\n")
              : JSON.stringify(m.payload.content);
        const time = compactTime();
        // Sender-less rows are channel announcements (#687) — frame by channel, never "unknown".
        const prefix = sender
          ? multiChannel
            ? `[${sender} in ${m.channel} — ${time}]`
            : `[${sender} — ${time}]`
          : `[${m.channel} — ${time}]`;
        return `${prefix}\n${text}`;
      })
      .join("\n\n");

    const content: VoluteContentPart[] = [{ type: "text", text: `${header}\n\n${body}` }];

    // Resolve session config for instructions
    const config = options.configPath ? loadRoutingConfig(options.configPath) : {};
    const sessionConfig = resolveSessionConfig(config, session);
    const withInstructions = prependInstructionsOnce(content, sessionConfig.instructions, session);

    const messageId = generateMessageId();
    const handler = options.mindHandler(session);

    try {
      handler.handle(withInstructions, { sessionName: session, messageId });
      log("router", `dispatched batch for session ${session}: ${allMessages.length} messages`);
    } catch (err) {
      log("router", `error dispatching batch for session ${session}:`, err);
    }
  }

  return { dispatch, dispatchBatch };
}
