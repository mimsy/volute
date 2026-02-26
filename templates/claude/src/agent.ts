import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { toSDKContent } from "./lib/content.js";
import { createAutoCommitHook } from "./lib/hooks/auto-commit.js";
import { createIdentityReloadHook } from "./lib/hooks/identity-reload.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- used as value
import { createPreCompactHook } from "./lib/hooks/pre-compact.js";
import { createReplyInstructionsHook } from "./lib/hooks/reply-instructions.js";
import { createSessionContextHook } from "./lib/hooks/session-context.js";
import { log } from "./lib/logger.js";
import { createMessageChannel } from "./lib/message-channel.js";
import { createSessionStore } from "./lib/session-store.js";
import { loadPrompts } from "./lib/startup.js";
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
  messageChannels: Map<string, string>;
};

export function createMind(options: {
  systemPrompt: string;
  cwd: string;
  abortController: AbortController;
  model?: string;
  maxThinkingTokens?: number;
  sessionsDir: string;
  compactionMessage?: string;
  maxContextTokens?: number;
  onIdentityReload?: () => Promise<void>;
}): { resolve: HandlerResolver; waitForCommits: () => Promise<void> } {
  const autoCommit = createAutoCommitHook(options.cwd);
  const identityReload = createIdentityReloadHook(options.cwd);
  const sessionStore = createSessionStore(options.sessionsDir);
  const postToolUseHooks: { matcher: string; hooks: HookCallback[] }[] = [
    { matcher: "Edit|Write", hooks: [autoCommit.hook, identityReload.hook] },
  ];

  const sessions = new Map<string, Session>();
  const prompts = loadPrompts();
  const today = new Date().toLocaleDateString("en-CA");
  const compactionMessage =
    options.compactionMessage ?? prompts.compaction_warning.replace("${date}", today);
  const compactionInstructions = prompts.compaction_instructions;
  const maxContextTokens = options.maxContextTokens;

  if (maxContextTokens) {
    log("mind", `compaction threshold: ${maxContextTokens} tokens`);
  }

  // Per-session compaction state
  const compactionTriggered = new Map<string, boolean>();

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

  function createStream(
    session: Session,
    streamAbort: AbortController,
    preCompactHook: HookCallback,
    resume?: string,
  ) {
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
        abortController: streamAbort,
        model: options.model,
        maxThinkingTokens: options.maxThinkingTokens,
        resume,
        hooks: {
          PostToolUse: postToolUseHooks,
          PreCompact: [{ hooks: [preCompactHook] }],
          UserPromptSubmit: [{ hooks: [sessionContext.hook, replyInstructions.hook] }],
        },
      },
    });
  }

  /** Sentinel error used to signal that the stream was aborted for compaction */
  class CompactionAbort extends Error {}

  function startSession(session: Session, savedSessionId?: string) {
    (async () => {
      log("mind", `session "${session.name}": stream consumer started`);
      let currentSessionId = savedSessionId;
      let streamAbort = new AbortController();

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

      const callbacks = {
        onSessionId: (id: string) => {
          currentSessionId = id;
          if (!session.name.startsWith("new-")) sessionStore.save(session.name, id);
        },
        broadcast: (event: VoluteEvent) => broadcastToSession(session, event),
        onTurnEnd: () => {
          const wasCompacting = compactionTriggered.get(session.name);
          compactionTriggered.set(session.name, false);
          if (wasCompacting) {
            // Mind just finished saving state — abort the stream so we can /compact
            log("mind", `session "${session.name}": aborting stream for compaction`);
            streamAbort.abort(new CompactionAbort());
          } else if (identityReload.needsReload()) {
            options.onIdentityReload?.();
          }
        },
        onContextTokens: maxContextTokens
          ? (tokens: number) => {
              if (tokens >= maxContextTokens && !compactionTriggered.get(session.name)) {
                compactionTriggered.set(session.name, true);
                log(
                  "mind",
                  `session "${session.name}": ${tokens} tokens >= ${maxContextTokens} — triggering compaction`,
                );
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
              }
            }
          : undefined,
      };

      async function runCompact(sessionId: string) {
        log("mind", `session "${session.name}": compacting with custom instructions`);
        const compactAbort = new AbortController();
        // Forward mind-level abort to the compact query
        options.abortController.signal.addEventListener("abort", () => compactAbort.abort(), {
          once: true,
        });
        const compactQuery = query({
          prompt: `/compact ${compactionInstructions}`,
          options: {
            systemPrompt: options.systemPrompt,
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            settingSources: ["project"],
            cwd: options.cwd,
            abortController: compactAbort,
            model: options.model,
            resume: sessionId,
          },
        });
        for await (const msg of compactQuery) {
          if ("session_id" in msg && msg.session_id) {
            currentSessionId = msg.session_id as string;
            if (!session.name.startsWith("new-")) {
              sessionStore.save(session.name, currentSessionId);
            }
          }
        }
        log("mind", `session "${session.name}": compaction complete`);
      }

      async function runStream(resume?: string) {
        const q = createStream(session, streamAbort, preCompact.hook, resume);
        session.currentQuery = q;
        await consumeStream(q, session, callbacks);
        if (session.currentMessageId !== undefined) {
          session.messageChannels.delete(session.currentMessageId);
          broadcastToSession(session, { type: "done" });
          session.currentMessageId = undefined;
        }
      }

      try {
        // eslint-disable-next-line no-constant-condition -- abort breaks the loop
        while (true) {
          try {
            await runStream(currentSessionId);
            break; // stream ended normally
          } catch (err) {
            if (
              streamAbort.signal.aborted &&
              streamAbort.signal.reason instanceof CompactionAbort &&
              currentSessionId
            ) {
              // Stream was aborted for compaction — run /compact then resume
              await runCompact(currentSessionId);
              streamAbort = new AbortController();
              const pending = session.channel.drain();
              session.channel = createMessageChannel();
              for (const msg of pending) session.channel.push(msg);
              continue; // restart the stream loop
            }
            throw err; // rethrow non-compaction errors
          }
        }
      } catch (err) {
        session.messageChannels.clear();
        if (currentSessionId) {
          log("mind", `session "${session.name}": resume failed, starting fresh:`, err);
          sessionStore.delete(session.name);
          currentSessionId = undefined;
          streamAbort = new AbortController();
          session.channel = createMessageChannel();
          try {
            await runStream();
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

    const session: Session = {
      name,
      channel: createMessageChannel(),
      listeners: new Set(),
      messageIds: [],
      messageChannels: new Map(),
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

        // Track channel for reply instructions
        if (meta.channel) {
          session.messageChannels.set(meta.messageId, meta.channel);
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
