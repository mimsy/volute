import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { extractImages, extractText } from "./lib/content.js";
import {
  countSdkInstructionTokens,
  countSkillDescriptionTokens,
  countSystemPromptTokens,
  findPiSessionFile,
  parsePiSessionJSONL,
} from "./lib/context-breakdown.js";
import { createEventHandler, emit } from "./lib/event-handler.js";
import { runHooks } from "./lib/hook-loader.js";
import { log } from "./lib/logger.js";
import { createReplyInstructionsExtension } from "./lib/reply-instructions-extension.js";
import { resolveModel } from "./lib/resolve-model.js";
import { getStartupContext, loadPrompts, type SubagentConfig } from "./lib/startup.js";
import { createSubagentExtension, type SubagentDefinition } from "./lib/subagents.js";
import type {
  HandlerMeta,
  HandlerResolver,
  Listener,
  MessageHandler,
  VoluteContentPart,
  VoluteEvent,
} from "./lib/types.js";
import type { ContextInfo } from "./lib/volute-server.js";

type PiAgentSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

type PiSession = {
  name: string;
  agentSession: PiAgentSession | null;
  ready: Promise<void>;
  listeners: Set<Listener>;
  unsubscribe?: () => void;
  messageIds: (string | undefined)[];
  currentMessageId?: string;
  messageChannels: Map<string, { channel: string; sender?: string }>;
  contextTokens: number;
};

export function createMind(options: {
  systemPrompt: string;
  cwd: string;
  mindDir: string;
  model?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  compactionMessage?: string;
  maxContextTokens?: number;
  subagents?: Record<string, SubagentConfig>;
}): { resolve: HandlerResolver; getContextInfo: () => ContextInfo } {
  const sessions = new Map<string, PiSession>();
  const prompts = loadPrompts();
  const today = new Date().toLocaleDateString("en-CA");
  const compactionMessage =
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${date} in prompt template
    options.compactionMessage ?? prompts.compaction_warning.replace("${date}", today);
  const compactionInstructions = prompts.compaction_instructions;
  const maxContextTokens = options.maxContextTokens;

  if (maxContextTokens) {
    log("mind", `compaction threshold: ${maxContextTokens} tokens`);
  }

  // Shared setup (created once)
  const modelStr = options.model || process.env.PI_MODEL || "anthropic:claude-sonnet-4-20250514";
  const model = resolveModel(modelStr);
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  // --- Subagents (config-driven) ---

  function loadSubagents(
    configs: Record<string, SubagentConfig> | undefined,
  ): Record<string, SubagentDefinition> {
    const result: Record<string, SubagentDefinition> = {};
    if (!configs) return result;
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
        result[name] = {
          description: config.description,
          prompt,
          tools: config.tools,
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
    return result;
  }

  const subagents = loadSubagents(options.subagents);

  const subagentExtension =
    Object.keys(subagents).length > 0
      ? createSubagentExtension(subagents, { cwd: options.cwd, model, authStorage, modelRegistry })
      : undefined;

  // --- Startup context (loaded once, injected on first turn per session) ---

  const startupContextPromise = getStartupContext().catch(() => null);

  // --- Dynamic hook extension ---

  const hooksDir = resolvePath(options.cwd, ".local/hooks");

  function createDynamicHookExtension(session: PiSession): ExtensionFactory {
    let startupContextInjected = false;
    const pendingToolArgs = new Map<string, Record<string, unknown>>();

    return (pi) => {
      pi.on("tool_execution_start", (event) => {
        pendingToolArgs.set(event.toolCallId, event.args);
      });

      pi.on("before_agent_start", async () => {
        const parts: string[] = [];

        // Inject startup context on the first turn of each session
        if (!startupContextInjected) {
          startupContextInjected = true;
          const startupContext = await startupContextPromise;
          if (startupContext) {
            emit(session, {
              type: "context",
              content: startupContext,
              metadata: { source: "startup-context" },
            });
            parts.push(startupContext);
          }
        }

        try {
          const result = await runHooks(hooksDir, "pre-prompt", {
            event: "pre-prompt",
            session: session.name,
          });
          if (result.additionalContext) {
            emit(session, {
              type: "context",
              content: result.additionalContext,
              metadata: { source: "dynamic:pre-prompt", ...result.metadata },
            });
            parts.push(result.additionalContext);
          }
        } catch (err) {
          log("mind", "dynamic pre-prompt hook failed:", err);
        }

        if (parts.length > 0) {
          return {
            message: {
              customType: "dynamic-hook",
              content: parts.join("\n\n"),
              display: true,
            },
          };
        }
        return {};
      });

      pi.on("tool_execution_end", async (event) => {
        const toolInput = pendingToolArgs.get(event.toolCallId);
        pendingToolArgs.delete(event.toolCallId);
        try {
          const result = await runHooks(hooksDir, "post-tool-use", {
            event: "post-tool-use",
            tool_name: event.toolName,
            tool_input: toolInput,
          });
          if (result.additionalContext) {
            emit(session, {
              type: "context",
              content: result.additionalContext,
              metadata: { source: "dynamic:post-tool-use", ...result.metadata },
            });
          }
        } catch (err) {
          log("mind", "dynamic post-tool-use hook failed:", err);
        }
      });
    };
  }

  // --- Session lifecycle ---

  function getOrCreateSession(name: string): PiSession {
    const existing = sessions.get(name);
    if (existing) return existing;

    const session: PiSession = {
      name,
      agentSession: null,
      ready: Promise.resolve(),
      listeners: new Set(),
      messageIds: [],
      messageChannels: new Map(),
      contextTokens: 0,
    };
    sessions.set(name, session);

    session.ready = initSession(session).catch((err) => {
      session.messageChannels.clear();
      log("mind", `session "${session.name}": init failed:`, err);
    });
    return session;
  }

  async function initSession(session: PiSession) {
    const isEphemeral = session.name.startsWith("new-");

    const sessionManager = isEphemeral
      ? SessionManager.inMemory()
      : SessionManager.continueRecent(options.cwd, `.mind/pi-sessions/${session.name}`);

    log("mind", `session "${session.name}": ${isEphemeral ? "ephemeral" : "persistent"}`);

    // Compaction state machine:
    // 1. onContextTokens sets compactionTriggered=true and sends warning
    // 2. onTurnEnd (after warning turn): compactionTriggered -> compactOnNextTurnEnd
    // 3. onTurnEnd (after mind's save turn): compactOnNextTurnEnd -> call compact()
    let compactBlocked = false;
    let manualCompactPending = false;
    let compactionTriggered = false;
    let compactOnNextTurnEnd = false;
    let compactionInProgress = false;

    function resetCompactionState() {
      compactionTriggered = false;
      compactOnNextTurnEnd = false;
      compactionInProgress = false;
    }

    const preCompactExtension: ExtensionFactory = (pi) => {
      pi.on("session_before_compact", () => {
        // Our programmatic compact() call (triggered by token threshold) — allow through
        if (manualCompactPending) {
          manualCompactPending = false;
          log(
            "mind",
            `session "${session.name}": allowing manual compaction with custom instructions`,
          );
          return;
        }

        // Auto-compaction: two-pass block (first pass warns mind, second pass allows)
        if (!compactBlocked) {
          compactBlocked = true;
          log(
            "mind",
            `session "${session.name}": blocking compaction — asking mind to update daily log`,
          );
          session.messageIds.push(undefined);
          session.agentSession?.prompt(compactionMessage, { streamingBehavior: "followUp" });
          return { cancel: true };
        }
        compactBlocked = false;
        log("mind", `session "${session.name}": allowing compaction`);
      });
    };

    const settingsManager = SettingsManager.inMemory({
      retry: { enabled: true, maxRetries: 3 },
    });

    const replyInstructionsExtension = createReplyInstructionsExtension(
      session.messageChannels,
      emit,
      session,
    );

    const dynamicHookExtension = createDynamicHookExtension(session);

    const resourceLoader = new DefaultResourceLoader({
      cwd: options.cwd,
      settingsManager,
      systemPrompt: options.systemPrompt,
      extensionFactories: [
        preCompactExtension,
        replyInstructionsExtension,
        ...(subagentExtension ? [subagentExtension] : []),
        dynamicHookExtension,
      ],
    });
    await resourceLoader.reload();

    const { session: agentSession } = await createAgentSession({
      cwd: options.cwd,
      model,
      thinkingLevel: options.thinkingLevel,
      authStorage,
      modelRegistry,
      sessionManager,
      settingsManager,
      resourceLoader,
    });

    session.agentSession = agentSession;

    session.unsubscribe = agentSession.subscribe(
      createEventHandler(session, {
        cwd: options.cwd,
        broadcast: (event) => broadcast(session, event),
        onContextTokens: (tokens: number) => {
          session.contextTokens = tokens;
          if (
            maxContextTokens &&
            tokens >= maxContextTokens &&
            !compactionTriggered &&
            !compactionInProgress
          ) {
            if (!session.agentSession) {
              log(
                "mind",
                `session "${session.name}": compaction threshold hit but session not ready`,
              );
              return;
            }
            compactionTriggered = true;
            log(
              "mind",
              `session "${session.name}": ${tokens} tokens >= ${maxContextTokens} — triggering compaction`,
            );
            // Send compaction warning; compaction will follow after the mind finishes its response turn
            session.messageIds.push(undefined);
            session.agentSession.prompt(compactionMessage, {
              streamingBehavior: "followUp",
            });
          }
        },
        onTurnEnd: maxContextTokens
          ? () => {
              try {
                // Compact on the turn AFTER the warning was sent (so the mind gets a turn to save state)
                if (compactOnNextTurnEnd) {
                  compactOnNextTurnEnd = false;
                  manualCompactPending = true;
                  compactionInProgress = true;
                  log("mind", `session "${session.name}": compacting with custom instructions`);
                  Promise.resolve(session.agentSession?.compact(compactionInstructions))
                    .catch((err) =>
                      log("mind", `session "${session.name}": compact() failed:`, err),
                    )
                    .finally(() => {
                      compactionInProgress = false;
                    });
                }
                if (compactionTriggered) {
                  compactionTriggered = false;
                  compactOnNextTurnEnd = true;
                }
              } catch (err) {
                log(
                  "mind",
                  `session "${session.name}": onTurnEnd error, resetting compaction state:`,
                  err,
                );
                resetCompactionState();
              }
            }
          : undefined,
      }),
    );

    log("mind", `session "${session.name}": ready`);
  }

  // --- Event broadcasting ---

  function broadcast(session: PiSession, event: VoluteEvent) {
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

  function interruptSession(name: string) {
    const session = sessions.get(name);
    if (session?.currentMessageId !== undefined) {
      log("mind", `session "${name}": interrupting current turn`);
      broadcast(session, { type: "done" });
      session.currentMessageId = undefined;
    }
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
          session.messageChannels.set(meta.messageId, {
            channel: meta.channel,
            sender: meta.sender,
          });
        }

        // Track messageId (must be pushed before prompt)
        session.messageIds.push(meta.messageId);

        const text = extractText(content);
        const images = extractImages(content);
        const opts = images.length ? { images } : {};

        // Fire-and-forget: await session ready then prompt
        (async () => {
          await session.ready;
          if (!session.agentSession) {
            log("mind", `session "${sessionName}": not initialized, dropping message`);
            broadcast(session, { type: "done" });
            return;
          }
          if (session.agentSession.isStreaming) {
            if (meta.interrupt) {
              interruptSession(sessionName);
              session.agentSession.prompt(text, { streamingBehavior: "steer", ...opts });
            } else {
              session.agentSession.prompt(text, { streamingBehavior: "followUp", ...opts });
            }
          } else {
            session.agentSession.prompt(text, opts);
          }
        })().catch((err) => {
          log("mind", `session "${sessionName}": prompt failed:`, err);
          broadcast(session, { type: "done" });
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

  const piSessionsDir = resolvePath(options.mindDir, ".mind/pi-sessions");
  const systemPromptTokens = countSystemPromptTokens(options.systemPrompt);
  const claudeMdTokens = countSdkInstructionTokens(options.cwd);
  const skillDescTokens = countSkillDescriptionTokens([resolvePath(options.cwd, ".pi/skills")]);

  function getContextInfo(): ContextInfo {
    return {
      sessions: Array.from(sessions.values()).map((s) => {
        try {
          const jsonlPath = findPiSessionFile(piSessionsDir, s.name);
          const parsed = jsonlPath
            ? parsePiSessionJSONL(jsonlPath, systemPromptTokens, claudeMdTokens, skillDescTokens)
            : null;

          return {
            name: s.name,
            contextTokens: parsed?.contextTokens ?? s.contextTokens,
            contextWindow: maxContextTokens,
            breakdown: parsed?.breakdown,
          };
        } catch (err) {
          log("mind", `failed to get context breakdown for session "${s.name}":`, err);
          return { name: s.name, contextTokens: s.contextTokens, contextWindow: maxContextTokens };
        }
      }),
      systemPrompt: systemPromptTokens,
    };
  }

  return { resolve, getContextInfo };
}
