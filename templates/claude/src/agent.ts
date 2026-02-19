import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  type AutoReplyTracker,
  createAutoReplyTracker,
  type MessageChannelInfo,
} from "./lib/auto-reply.js";
import { toSDKContent } from "./lib/content.js";
import { createAutoCommitHook } from "./lib/hooks/auto-commit.js";
import { createIdentityReloadHook } from "./lib/hooks/identity-reload.js";
import { createPreCompactHook } from "./lib/hooks/pre-compact.js";
import { createReplyInstructionsHook } from "./lib/hooks/reply-instructions.js";
import { createSessionContextHook } from "./lib/hooks/session-context.js";
import { log } from "./lib/logger.js";
import { createMessageChannel } from "./lib/message-channel.js";
import { createSessionStore } from "./lib/session-store.js";
import { consumeStream } from "./lib/stream-consumer.js";
import type {
  HandlerMeta,
  HandlerResolver,
  Listener,
  MessageHandler,
  VoluteContentPart,
  VoluteEvent,
} from "./lib/types.js";

type Session = {
  name: string;
  channel: ReturnType<typeof createMessageChannel>;
  listeners: Set<Listener>;
  messageIds: (string | undefined)[];
  currentMessageId?: string;
  currentQuery?: ReturnType<typeof query>;
  messageChannels: Map<string, MessageChannelInfo>;
  autoReply: AutoReplyTracker;
};

export function createMind(options: {
  systemPrompt: string;
  cwd: string;
  abortController: AbortController;
  model?: string;
  maxThinkingTokens?: number;
  sessionsDir: string;
  compactionMessage?: string;
  onIdentityReload?: () => Promise<void>;
}): { resolve: HandlerResolver; waitForCommits: () => Promise<void> } {
  const autoCommit = createAutoCommitHook(options.cwd);
  const identityReload = createIdentityReloadHook(options.cwd);
  const sessionStore = createSessionStore(options.sessionsDir);
  const postToolUseHooks: { matcher: string; hooks: HookCallback[] }[] = [
    { matcher: "Edit|Write", hooks: [autoCommit.hook, identityReload.hook] },
  ];

  const sessions = new Map<string, Session>();
  const today = new Date().toISOString().slice(0, 10);
  const compactionMessage =
    options.compactionMessage ??
    `Context is getting long — compaction is about to summarize this conversation. Before that happens, save anything important to files (MEMORY.md, memory/journal/${today}.md, etc.) since those survive compaction. Focus on: decisions made, open tasks, and anything you'd need to pick up where you left off.`;

  // --- Event broadcasting ---

  function broadcastToSession(session: Session, event: VoluteEvent) {
    const tagged =
      session.currentMessageId != null ? { ...event, messageId: session.currentMessageId } : event;
    for (const listener of session.listeners) {
      try {
        listener(tagged);
      } catch (err) {
        log("mind", "listener threw during broadcast:", err);
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

    const sessionContext = createSessionContextHook({
      currentSession: session.name,
      sessionsDir: options.sessionsDir,
      cwd: options.cwd,
    });

    const replyInstructions = createReplyInstructionsHook(session.messageChannels);

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
        maxThinkingTokens: options.maxThinkingTokens,
        resume,
        hooks: {
          PostToolUse: postToolUseHooks,
          PreCompact: [{ hooks: [preCompact.hook] }],
          UserPromptSubmit: [{ hooks: [sessionContext.hook, replyInstructions.hook] }],
        },
      },
    });
  }

  function startSession(session: Session, savedSessionId?: string) {
    (async () => {
      log("mind", `session "${session.name}": stream consumer started`);
      const callbacks = {
        onSessionId: (id: string) => {
          if (!session.name.startsWith("new-")) sessionStore.save(session.name, id);
        },
        broadcast: (event: VoluteEvent) => broadcastToSession(session, event),
        onTurnEnd: () => {
          if (identityReload.needsReload()) options.onIdentityReload?.();
        },
      };
      try {
        const q = createStream(session, savedSessionId);
        session.currentQuery = q;
        await consumeStream(q, session, callbacks);
        // Stream ended — flush any pending auto-reply and broadcast done if no result was emitted
        session.autoReply.flush(session.currentMessageId);
        if (session.currentMessageId !== undefined) {
          session.messageChannels.delete(session.currentMessageId);
          broadcastToSession(session, { type: "done" });
          session.currentMessageId = undefined;
        }
      } catch (err) {
        session.autoReply.reset();
        session.messageChannels.clear();
        if (savedSessionId) {
          log("mind", `session "${session.name}": resume failed, starting fresh:`, err);
          sessionStore.delete(session.name);
          try {
            const q = createStream(session);
            session.currentQuery = q;
            await consumeStream(q, session, callbacks);
            session.autoReply.flush(session.currentMessageId);
            if (session.currentMessageId !== undefined) {
              session.messageChannels.delete(session.currentMessageId);
              broadcastToSession(session, { type: "done" });
              session.currentMessageId = undefined;
            }
          } catch (retryErr) {
            log("mind", `session "${session.name}": stream consumer error:`, retryErr);
            broadcastToSession(session, { type: "done" });
            sessions.delete(session.name);
          }
        } else {
          log("mind", `session "${session.name}": stream consumer error:`, err);
          broadcastToSession(session, { type: "done" });
          sessions.delete(session.name);
        }
      }
      log("mind", `session "${session.name}": stream consumer ended`);
    })();
  }

  function getOrCreateSession(name: string): Session {
    const existing = sessions.get(name);
    if (existing) return existing;

    const messageChannels = new Map<string, MessageChannelInfo>();
    const session: Session = {
      name,
      channel: createMessageChannel(),
      listeners: new Set(),
      messageIds: [],
      messageChannels,
      autoReply: createAutoReplyTracker(messageChannels),
    };
    sessions.set(name, session);

    const isEphemeral = name.startsWith("new-");
    const savedSessionId = isEphemeral ? undefined : sessionStore.load(name);
    if (savedSessionId) {
      log("mind", `session "${name}": resuming ${savedSessionId}`);
    } else {
      log("mind", `session "${name}": starting fresh`);
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

        // Track channel for auto-reply
        if (meta.channel) {
          session.messageChannels.set(meta.messageId, {
            channel: meta.channel,
            autoReply: meta.autoReply,
          });
        }

        // Interrupt if requested and session is mid-turn
        if (meta.interrupt && session.currentMessageId !== undefined && session.currentQuery) {
          log("mind", `session "${sessionName}": interrupting current turn`);
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
