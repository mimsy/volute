import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { toSDKContent } from "./lib/content.js";
import { daemonEmit } from "./lib/daemon-client.js";
import { runHooks } from "./lib/hook-loader.js";
import { createAutoCommitHook } from "./lib/hooks/auto-commit.js";
import { createIdentityReloadHook } from "./lib/hooks/identity-reload.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- used as value
import { createPreCompactHook } from "./lib/hooks/pre-compact.js";
import { createReplyInstructionsHook } from "./lib/hooks/reply-instructions.js";
import { log } from "./lib/logger.js";
import { createMessageChannel } from "./lib/message-channel.js";
import { createSessionStore } from "./lib/session-store.js";
import { loadPrompts, type SubagentConfig } from "./lib/startup.js";
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
  subagents?: Record<string, SubagentConfig>;
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

  // --- Subagents (config-driven) ---

  type SDKAgent = {
    description: string;
    prompt: string;
    tools: string[];
    model: "inherit";
    maxTurns?: number;
  };

  function loadSubagents(
    configs: Record<string, SubagentConfig> | undefined,
  ): Record<string, SDKAgent> | undefined {
    if (!configs || Object.keys(configs).length === 0) return undefined;
    const agents: Record<string, SDKAgent> = {};
    for (const [name, config] of Object.entries(configs)) {
      if (typeof config.description !== "string" || typeof config.systemPrompt !== "string") {
        log("mind", `subagent "${name}": missing description or systemPrompt, skipping`);
        continue;
      }
      try {
        const prompt = readFileSync(resolvePath(options.cwd, config.systemPrompt), "utf-8");
        if (!prompt) {
          log("mind", `subagent "${name}": ${config.systemPrompt} is empty, skipping`);
          continue;
        }
        agents[name] = {
          description: config.description,
          prompt,
          tools: config.tools ?? ["Read", "Write", "Bash"],
          model: "inherit" as const,
          maxTurns: config.maxTurns,
        };
      } catch (err: any) {
        if (err?.code === "ENOENT") {
          log("mind", `subagent "${name}": ${config.systemPrompt} not found, skipping`);
        } else {
          log("mind", `subagent "${name}": failed to read ${config.systemPrompt}: ${err.message}`);
        }
      }
    }
    return Object.keys(agents).length > 0 ? agents : undefined;
  }

  const agents = loadSubagents(options.subagents);

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

  // --- Hook event emission ---

  const hooksDir = resolvePath(options.cwd, ".config/hooks");

  function wrapHookWithEmit(hook: HookCallback, source: string, session: Session): HookCallback {
    return async (...args) => {
      const result = await hook(...args);
      const additionalContext = (result as any)?.hookSpecificOutput?.additionalContext;
      const decision = (result as any)?.decision;
      if (additionalContext || decision) {
        const channel = session.currentMessageId
          ? session.messageChannels.get(session.currentMessageId)
          : undefined;
        try {
          daemonEmit({
            type: "context",
            content: additionalContext,
            metadata: { source, ...(decision ? { hookAction: decision } : {}) },
            session: session.name,
            channel,
            messageId: session.currentMessageId,
          });
        } catch (err) {
          log("mind", `hook emit failed for ${source}:`, err);
        }
      }
      return result;
    };
  }

  function createDynamicHook(event: string, session: Session): HookCallback {
    return async (input) => {
      try {
        const result = await runHooks(hooksDir, event, input as Record<string, unknown>);
        if (result.additionalContext || Object.keys(result.metadata).length > 0) {
          const channel = session.currentMessageId
            ? session.messageChannels.get(session.currentMessageId)
            : undefined;
          try {
            daemonEmit({
              type: "context",
              content: result.additionalContext,
              metadata: { source: `dynamic:${event}`, ...result.metadata },
              session: session.name,
              channel,
              messageId: session.currentMessageId,
            });
          } catch (err) {
            log("mind", `dynamic hook emit failed for ${event}:`, err);
          }
        }
        // Only UserPromptSubmit hooks can inject additionalContext into the conversation
        if (event !== "pre-prompt" || !result.additionalContext) return {};
        return {
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit" as const,
            additionalContext: result.additionalContext,
          },
        };
      } catch (err) {
        log("mind", `dynamic ${event} hook failed:`, err);
        return {};
      }
    };
  }

  // --- SDK stream management ---

  function createStream(
    session: Session,
    streamAbort: AbortController,
    preCompactHook: HookCallback,
    resume?: string,
  ) {
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
        agents,
        hooks: {
          PostToolUse: [
            ...postToolUseHooks,
            {
              matcher: ".*",
              hooks: [createDynamicHook("post-tool-use", session)],
            },
          ],
          PreCompact: [{ hooks: [wrapHookWithEmit(preCompactHook, "pre-compact", session)] }],
          UserPromptSubmit: [
            {
              hooks: [
                wrapHookWithEmit(replyInstructions.hook, "reply-instructions", session),
                createDynamicHook("pre-prompt", session),
              ],
            },
          ],
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
        onTurnEnd: async () => {
          await autoCommit.flushFileChanges();
          const wasCompacting = compactionTriggered.get(session.name);
          compactionTriggered.set(session.name, false);
          if (wasCompacting) {
            // Mind's turn after compaction warning is done — abort the stream to run /compact
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
        let gotResult = false;
        for await (const msg of compactQuery) {
          if ("session_id" in msg && msg.session_id) {
            currentSessionId = msg.session_id as string;
            if (!session.name.startsWith("new-")) {
              sessionStore.save(session.name, currentSessionId);
            }
          }
          if (msg.type === "result") gotResult = true;
        }
        if (!gotResult)
          log("mind", `session "${session.name}": compaction stream ended without result`);
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
        // eslint-disable-next-line no-constant-condition -- loop exits via break (normal) or throw (error)
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
              // Stream was aborted for compaction — run /compact, then loop to resume
              try {
                await runCompact(currentSessionId);
              } catch (compactErr) {
                log(
                  "mind",
                  `session "${session.name}": custom compaction failed, starting fresh:`,
                  compactErr,
                );
                sessionStore.delete(session.name);
                currentSessionId = undefined;
                streamAbort = new AbortController();
                session.channel = createMessageChannel();
                break;
              }
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
