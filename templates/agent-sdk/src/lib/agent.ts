import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createAutoCommitHook } from "./hooks/auto-commit.js";
import { createIdentityReloadHook } from "./hooks/identity-reload.js";
import { createPreCompactHook } from "./hooks/pre-compact.js";
import { log, logMessage, logText, logThinking, logToolUse } from "./logger.js";
import { createMessageChannel } from "./message-channel.js";
import type { ChannelMeta, VoluteContentPart, VoluteEvent } from "./types.js";

type Listener = (event: VoluteEvent) => void;

type Session = {
  name: string;
  channel: ReturnType<typeof createMessageChannel>;
  listeners: Set<Listener>;
};

function formatPrefix(meta: ChannelMeta | undefined, time: string): string {
  if (!meta?.channel && !meta?.sender) return "";
  // Use explicit platform name or capitalize from channel URI prefix
  const platform =
    meta.platform ??
    (() => {
      const n = (meta.channel ?? "").split(":")[0];
      return n.charAt(0).toUpperCase() + n.slice(1);
    })();
  // Build sender context (e.g., "alice in DM" or "alice in #general in My Server")
  let sender = meta.sender ?? "";
  if (meta.isDM) {
    sender += " in DM";
  } else if (meta.channelName) {
    sender += ` in #${meta.channelName}`;
    if (meta.guildName) sender += ` in ${meta.guildName}`;
  }
  const parts = [platform, sender].filter(Boolean);
  // Include session name if not the default
  const sessionPart =
    meta.sessionName && meta.sessionName !== "main" ? ` — session: ${meta.sessionName}` : "";
  return parts.length > 0 ? `[${parts.join(": ")}${sessionPart} — ${time}]\n` : "";
}

export function createAgent(options: {
  systemPrompt: string;
  cwd: string;
  abortController: AbortController;
  model?: string;
  sessionsDir: string;
  onIdentityReload?: () => Promise<void>;
}) {
  const sessions = new Map<string, Session>();

  // Shared hooks (operate on the filesystem, not per-session)
  const autoCommit = createAutoCommitHook(options.cwd);
  const identityReload = createIdentityReloadHook(options.cwd);

  function loadSessionId(sessionName: string): string | undefined {
    try {
      const path = resolve(options.sessionsDir, `${sessionName}.json`);
      const data = JSON.parse(readFileSync(path, "utf-8"));
      return data.sessionId;
    } catch {
      return undefined;
    }
  }

  function saveSessionId(sessionName: string, sessionId: string) {
    mkdirSync(options.sessionsDir, { recursive: true });
    const path = resolve(options.sessionsDir, `${sessionName}.json`);
    writeFileSync(path, JSON.stringify({ sessionId }));
  }

  function deleteSessionId(sessionName: string) {
    try {
      const path = resolve(options.sessionsDir, `${sessionName}.json`);
      if (existsSync(path)) unlinkSync(path);
    } catch {}
  }

  function getOrCreateSession(name: string): Session {
    const existing = sessions.get(name);
    if (existing) return existing;

    const session: Session = {
      name,
      channel: createMessageChannel(),
      listeners: new Set(),
    };
    sessions.set(name, session);

    // Don't try to resume ephemeral ($new) sessions
    const isEphemeral = name.startsWith("new-");
    const savedSessionId = isEphemeral ? undefined : loadSessionId(name);
    if (savedSessionId) {
      log("agent", `session "${name}": resuming ${savedSessionId}`);
    } else {
      log("agent", `session "${name}": starting fresh`);
    }

    startSession(session, savedSessionId);
    return session;
  }

  function broadcastToSession(session: Session, event: VoluteEvent) {
    for (const listener of session.listeners) {
      try {
        listener(event);
      } catch (err) {
        log("agent", "listener threw during broadcast:", err);
      }
    }
  }

  function createStream(session: Session, resume?: string) {
    // Pre-compact hook sends directly to this session's channel
    const preCompact = createPreCompactHook(() => {
      session.channel.push({
        type: "user",
        session_id: "",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "Conversation is about to be compacted. Please update today's daily log with a summary of what we've discussed and accomplished so far, so context is preserved before compaction.",
            },
          ],
        },
        parent_tool_use_id: null,
      });
    });

    return query({
      prompt: session.channel.iterable,
      options: {
        systemPrompt: options.systemPrompt,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: ["project"],
        cwd: options.cwd,
        abortController: options.abortController,
        model: options.model,
        resume,
        hooks: {
          PostToolUse: [{ matcher: "Edit|Write", hooks: [autoCommit.hook, identityReload.hook] }],
          PreCompact: [{ hooks: [preCompact.hook] }],
        },
      },
    });
  }

  async function consumeStream(stream: ReturnType<typeof query>, session: Session) {
    for await (const msg of stream) {
      if ("session_id" in msg && msg.session_id) {
        // Don't persist ephemeral session IDs
        if (!session.name.startsWith("new-")) {
          saveSessionId(session.name, msg.session_id as string);
        }
      }
      if (msg.type === "assistant") {
        for (const b of msg.message.content) {
          if (b.type === "thinking" && "thinking" in b && b.thinking) {
            logThinking(b.thinking as string);
          } else if (b.type === "text") {
            const text = (b as { text: string }).text;
            logText(text);
            broadcastToSession(session, { type: "text", content: text });
          } else if (b.type === "tool_use") {
            const tb = b as { name: string; input: unknown };
            logToolUse(tb.name, tb.input);
            broadcastToSession(session, { type: "tool_use", name: tb.name, input: tb.input });
          }
        }
      }
      if (msg.type === "result") {
        log("agent", `session "${session.name}": turn done`);
        broadcastToSession(session, { type: "done" });
        if (identityReload.needsReload()) {
          options.onIdentityReload?.();
        }
      }
    }
  }

  function startSession(session: Session, savedSessionId?: string) {
    (async () => {
      log("agent", `session "${session.name}": stream consumer started`);
      try {
        await consumeStream(createStream(session, savedSessionId), session);
      } catch (err) {
        if (savedSessionId) {
          log("agent", `session "${session.name}": resume failed, starting fresh:`, err);
          deleteSessionId(session.name);
          try {
            await consumeStream(createStream(session), session);
          } catch (retryErr) {
            log("agent", `session "${session.name}": stream consumer error:`, retryErr);
            sessions.delete(session.name);
          }
        } else {
          log("agent", `session "${session.name}": stream consumer error:`, err);
          sessions.delete(session.name);
        }
      }
      log("agent", `session "${session.name}": stream consumer ended`);
    })();
  }

  function sendMessage(content: string | VoluteContentPart[], meta?: ChannelMeta) {
    const sessionName = meta?.sessionName ?? "main";
    const session = getOrCreateSession(sessionName);

    const text =
      typeof content === "string"
        ? content
        : content.map((p) => (p.type === "text" ? p.text : `[${p.type}]`)).join(" ");
    logMessage("in", text, meta?.channel);

    // Build context prefix from channel metadata
    const time = new Date().toLocaleString();
    const prefix = formatPrefix(meta, time);

    let sdkContent: (
      | { type: "text"; text: string }
      | {
          type: "image";
          source: {
            type: "base64";
            media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
            data: string;
          };
        }
    )[];

    if (typeof content === "string") {
      sdkContent = [{ type: "text" as const, text: prefix + content }];
    } else {
      const hasText = content.some((p) => p.type === "text");
      sdkContent = content.map((part, i) => {
        if (part.type === "text") {
          return { type: "text" as const, text: (i === 0 ? prefix : "") + part.text };
        }
        return {
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: part.media_type as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
            data: part.data,
          },
        };
      });
      // If no text parts but we have a prefix, prepend a text part
      if (prefix && !hasText) {
        sdkContent.unshift({ type: "text" as const, text: prefix.trimEnd() });
      }
    }

    session.channel.push({
      type: "user",
      session_id: "",
      message: {
        role: "user",
        content: sdkContent,
      },
      parent_tool_use_id: null,
    });
  }

  function onMessage(listener: Listener, sessionName?: string): () => void {
    const name = sessionName ?? "main";
    const session = getOrCreateSession(name);
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  }

  return { sendMessage, onMessage, waitForCommits: autoCommit.waitForCommits };
}
