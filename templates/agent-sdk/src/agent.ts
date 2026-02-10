import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createAutoCommitHook } from "./lib/hooks/auto-commit.js";
import { createIdentityReloadHook } from "./lib/hooks/identity-reload.js";
import { createPreCompactHook } from "./lib/hooks/pre-compact.js";
import { log, logText, logThinking, logToolUse } from "./lib/logger.js";
import { createMessageChannel } from "./lib/message-channel.js";
import type {
  HandlerMeta,
  HandlerResolver,
  Listener,
  MessageHandler,
  VoluteContentPart,
  VoluteEvent,
} from "./lib/types.js";

type SDKContent = (
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

type Session = {
  name: string;
  channel: ReturnType<typeof createMessageChannel>;
  listeners: Set<Listener>;
  messageIds: (string | undefined)[];
  currentMessageId?: string;
  currentQuery?: ReturnType<typeof query>;
};

function toSDKContent(content: VoluteContentPart[]): SDKContent {
  return content.map((part) => {
    if (part.type === "text") {
      return { type: "text" as const, text: part.text };
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
}

export function createAgent(options: {
  systemPrompt: string;
  cwd: string;
  abortController: AbortController;
  model?: string;
  sessionsDir: string;
  compactionMessage?: string;
  onIdentityReload?: () => Promise<void>;
}): { resolve: HandlerResolver; waitForCommits: () => Promise<void> } {
  const autoCommit = createAutoCommitHook(options.cwd);
  const identityReload = createIdentityReloadHook(options.cwd);
  const postToolUseHooks: { matcher: string; hooks: HookCallback[] }[] = [
    { matcher: "Edit|Write", hooks: [autoCommit.hook, identityReload.hook] },
  ];

  const sessions = new Map<string, Session>();
  const compactionMessage =
    options.compactionMessage ??
    "Your conversation is approaching its context limit. Please update today's journal entry to preserve important context before the conversation is compacted.";

  // --- Session persistence ---

  function sessionFilePath(sessionName: string): string {
    return resolvePath(options.sessionsDir, `${sessionName}.json`);
  }

  function loadSessionId(sessionName: string): string | undefined {
    try {
      const data = JSON.parse(readFileSync(sessionFilePath(sessionName), "utf-8"));
      return data.sessionId;
    } catch {
      return undefined;
    }
  }

  function saveSessionId(sessionName: string, sessionId: string) {
    mkdirSync(options.sessionsDir, { recursive: true });
    writeFileSync(sessionFilePath(sessionName), JSON.stringify({ sessionId }));
  }

  function deleteSessionId(sessionName: string) {
    try {
      const path = sessionFilePath(sessionName);
      if (existsSync(path)) unlinkSync(path);
    } catch (err) {
      log("agent", `failed to delete session file for "${sessionName}":`, err);
    }
  }

  // --- Event broadcasting ---

  function broadcastToSession(session: Session, event: VoluteEvent) {
    const tagged =
      session.currentMessageId != null ? { ...event, messageId: session.currentMessageId } : event;
    for (const listener of session.listeners) {
      try {
        listener(tagged);
      } catch (err) {
        log("agent", "listener threw during broadcast:", err);
      }
    }
  }

  // --- SDK stream management ---

  function createStream(session: Session, resume?: string) {
    const preCompact = createPreCompactHook(() => {
      session.messageIds.push(undefined);
      session.channel.push({
        type: "user",
        session_id: "",
        message: {
          role: "user",
          content: [{ type: "text", text: compactionMessage }],
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
          PostToolUse: postToolUseHooks,
          PreCompact: [{ hooks: [preCompact.hook] }],
        },
      },
    });
  }

  async function consumeStream(stream: ReturnType<typeof query>, session: Session) {
    for await (const msg of stream) {
      if (session.currentMessageId === undefined) {
        session.currentMessageId = session.messageIds.shift();
      }
      if ("session_id" in msg && msg.session_id) {
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
        session.currentMessageId = undefined;
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
        const q = createStream(session, savedSessionId);
        session.currentQuery = q;
        await consumeStream(q, session);
      } catch (err) {
        if (savedSessionId) {
          log("agent", `session "${session.name}": resume failed, starting fresh:`, err);
          deleteSessionId(session.name);
          try {
            const q = createStream(session);
            session.currentQuery = q;
            await consumeStream(q, session);
          } catch (retryErr) {
            log("agent", `session "${session.name}": stream consumer error:`, retryErr);
            broadcastToSession(session, { type: "done" });
            sessions.delete(session.name);
          }
        } else {
          log("agent", `session "${session.name}": stream consumer error:`, err);
          broadcastToSession(session, { type: "done" });
          sessions.delete(session.name);
        }
      }
      log("agent", `session "${session.name}": stream consumer ended`);
    })();
  }

  function getOrCreateSession(name: string): Session {
    const existing = sessions.get(name);
    if (existing) return existing;

    const session: Session = {
      name,
      channel: createMessageChannel(),
      listeners: new Set(),
      messageIds: [],
    };
    sessions.set(name, session);

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

  // --- MessageHandler implementation ---

  function createSessionHandler(sessionName: string): MessageHandler {
    return {
      handle(content: VoluteContentPart[], meta: HandlerMeta, listener: Listener): () => void {
        const session = getOrCreateSession(sessionName);

        // Filter listener to only receive events for this messageId
        const filteredListener: Listener = (event) => {
          if (event.messageId === meta.messageId) listener(event);
        };
        session.listeners.add(filteredListener);

        // Interrupt if requested and session is mid-turn
        if (meta.interrupt && session.currentMessageId !== undefined && session.currentQuery) {
          log("agent", `session "${sessionName}": interrupting current turn`);
          session.currentQuery.interrupt();
        }

        // Push message into SDK
        session.messageIds.push(meta.messageId);
        session.channel.push({
          type: "user",
          session_id: "",
          message: { role: "user", content: toSDKContent(content) },
          parent_tool_use_id: null,
        });

        return () => session.listeners.delete(filteredListener);
      },
    };
  }

  // --- HandlerResolver ---

  const handlers = new Map<string, MessageHandler>();

  function resolve(sessionName: string): MessageHandler {
    // Ephemeral sessions get unique names — don't cache their handlers
    if (sessionName.startsWith("new-")) {
      return createSessionHandler(sessionName);
    }
    let handler = handlers.get(sessionName);
    if (!handler) {
      handler = createSessionHandler(sessionName);
      handlers.set(sessionName, handler);
    }
    return handler;
  }

  return { resolve, waitForCommits: autoCommit.waitForCommits };
}
