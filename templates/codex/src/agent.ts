import { readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { Codex } from "@openai/codex-sdk";
import { flushFileChanges, trackFileChange } from "./lib/auto-commit.js";
import { extractText } from "./lib/content.js";
import { findCodexSessionFile, parseCodexSessionJSONL } from "./lib/context-breakdown.js";
import { daemonEmit, daemonRestart, type EventType } from "./lib/daemon-client.js";
import { runHooks } from "./lib/hook-loader.js";
import { log, warn } from "./lib/logger.js";
import { createSessionStore } from "./lib/session-store.js";
import {
  getSkillsSizes,
  getStartupContext,
  getSystemPromptSizes,
  loadPrompts,
  loadSystemPrompt,
} from "./lib/startup.js";
import { filterEvent, loadTransparencyPreset } from "./lib/transparency.js";
import type {
  HandlerMeta,
  HandlerResolver,
  Listener,
  MessageHandler,
  VoluteContentPart,
  VoluteEvent,
} from "./lib/types.js";
import type { ContextInfo } from "./lib/volute-server.js";

/** Minimal interface for a Codex SDK thread — typed to the methods we actually use */
type CodexThread = {
  runStreamed(
    text: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ events: AsyncIterable<Record<string, any>> }>;
};

type CodexSession = {
  name: string;
  thread: CodexThread | null;
  listeners: Set<Listener>;
  currentMessageId?: string;
  messageQueue: Array<{ text: string; meta: HandlerMeta }>;
  processing: boolean;
  abortController?: AbortController;
  messageChannels: Map<string, string>;
  firstMessagePerChannel: Set<string>;
  cumulativeInputTokens: number;
};

// Loaded once at startup
const preset = loadTransparencyPreset();

function emit(
  session: CodexSession,
  event: { type: EventType; content?: string; metadata?: Record<string, unknown> },
) {
  const channel = session.currentMessageId
    ? session.messageChannels.get(session.currentMessageId)
    : undefined;
  const filtered = filterEvent(preset, {
    ...event,
    session: session.name,
    channel,
    messageId: session.currentMessageId,
  });
  if (filtered) daemonEmit(filtered);
}

export function createMind(options: {
  systemPrompt: string;
  cwd: string;
  mindDir: string;
  model?: string;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  maxContextTokens?: number;
}): { resolve: HandlerResolver; getContextInfo: () => ContextInfo } {
  const sessions = new Map<string, CodexSession>();
  const prompts = loadPrompts();
  const maxContextTokens = options.maxContextTokens;

  if (maxContextTokens) {
    log("mind", `compaction threshold: ${maxContextTokens} tokens`);
  }

  const sessionStore = createSessionStore(resolvePath(options.mindDir, ".mind/codex-sessions"));
  const hooksDir = resolvePath(options.cwd, ".local/hooks");
  const startupContextPromise = getStartupContext().catch(() => null);

  // Write system prompt to file for Codex model_instructions_file
  const promptPath = resolvePath(options.mindDir, ".mind/system-prompt.md");
  function refreshSystemPrompt() {
    try {
      // Re-read and re-compose the system prompt (picks up MEMORY.md changes)
      writeFileSync(promptPath, loadSystemPrompt());
    } catch (err) {
      warn("mind", "failed to refresh system prompt, using initial prompt:", err);
      writeFileSync(promptPath, options.systemPrompt);
    }
  }
  refreshSystemPrompt();

  // Use OPENAI_API_KEY if available, otherwise let codex CLI use its own auth (~/.codex/auth.json)
  const apiKey = process.env.OPENAI_API_KEY;

  const codex = new Codex({
    ...(apiKey ? { apiKey } : {}),
    config: {
      model_instructions_file: promptPath,
      // Let the SDK handle compaction natively when a threshold is configured
      model_auto_compact_token_limit: maxContextTokens ?? 999999999,
      // Enable reasoning summaries so they appear as events
      model_reasoning_summary: "auto",
      model_supports_reasoning_summaries: true,
      // The codex sandbox runs commands in /bin/zsh -lc which resets the environment.
      // Set ZDOTDIR so the login shell sources our .zshenv with VOLUTE env vars and PATH.
      shell_environment_policy: {
        inherit: "all",
        ignore_default_excludes: true,
        set: { ZDOTDIR: options.cwd },
      },
    },
  });

  // Track which sessions have received startup context
  const startupContextInjected = new Set<string>();

  // --- Session lifecycle ---

  function getOrCreateSession(name: string): CodexSession {
    const existing = sessions.get(name);
    if (existing) return existing;

    const session: CodexSession = {
      name,
      thread: null,
      listeners: new Set(),
      messageQueue: [],
      processing: false,
      messageChannels: new Map(),
      firstMessagePerChannel: new Set(),
      cumulativeInputTokens: 0,
    };
    sessions.set(name, session);

    initSession(session);
    return session;
  }

  function initSession(session: CodexSession) {
    const isEphemeral = session.name.startsWith("new-");
    log("mind", `session "${session.name}": ${isEphemeral ? "ephemeral" : "persistent"}`);
    emit(session, { type: "session_start" });

    if (!isEphemeral) {
      const savedThreadId = sessionStore.load(session.name);
      if (savedThreadId) {
        try {
          log("mind", `session "${session.name}": resuming thread ${savedThreadId}`);
          session.thread = codex.resumeThread(savedThreadId, {
            workingDirectory: options.cwd,
            model: options.model,
            modelReasoningEffort: options.reasoningEffort,
            skipGitRepoCheck: true,
            sandboxMode: "danger-full-access",
          });
          return;
        } catch (err) {
          warn("mind", `session "${session.name}": failed to resume thread, starting new:`, err);
        }
      }
    }

    try {
      session.thread = codex.startThread({
        workingDirectory: options.cwd,
        model: options.model,
        modelReasoningEffort: options.reasoningEffort,
        skipGitRepoCheck: true,
        sandboxMode: "danger-full-access",
      });
      log("mind", `session "${session.name}": new thread started`);
    } catch (err) {
      warn("mind", `session "${session.name}": failed to start thread:`, err);
    }
  }

  // --- Event broadcasting ---

  function broadcast(session: CodexSession, event: VoluteEvent) {
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

  // --- Turn execution ---

  async function runTurn(session: CodexSession, text: string, meta: HandlerMeta) {
    if (!session.thread) {
      warn("mind", `session "${session.name}": no thread, dropping message`);
      broadcast(session, { type: "done" });
      return;
    }

    // Refresh system prompt before each turn (picks up MEMORY.md changes)
    refreshSystemPrompt();

    // Inject startup context on the first turn of each session
    if (!startupContextInjected.has(session.name)) {
      startupContextInjected.add(session.name);
      const startupContext = await startupContextPromise;
      if (startupContext) {
        emit(session, {
          type: "context",
          content: startupContext,
          metadata: { source: "startup-context" },
        });
        text = `${startupContext}\n\n${text}`;
      }
    }

    // Run pre-prompt hooks
    try {
      const hookResult = await runHooks(hooksDir, "pre-prompt", {
        event: "pre-prompt",
        session: session.name,
      });
      if (hookResult.additionalContext) {
        emit(session, {
          type: "context",
          content: hookResult.additionalContext,
          metadata: { source: "dynamic:pre-prompt", ...hookResult.metadata },
        });
        text = `${hookResult.additionalContext}\n\n${text}`;
      }
    } catch (err) {
      warn("mind", "pre-prompt hook failed:", err);
    }

    // Reply instructions on first message per channel (skip system messages)
    const channel = meta.channel;
    if (channel && !session.firstMessagePerChannel.has(channel)) {
      session.firstMessagePerChannel.add(channel);
      const isSystem = meta.sender === "volute";
      const replyInstructions = isSystem
        ? "This is a system message — no reply is needed."
        : prompts.reply_instructions.replace(/\$\{channel\}/g, channel);
      emit(session, {
        type: "context",
        content: replyInstructions,
        metadata: { source: "reply-instructions" },
      });
      text = `${replyInstructions}\n\n${text}`;
    }

    session.abortController = new AbortController();

    // Sync VOLUTE_SESSION to .zshenv so codex shell commands know which session they're in.
    // process.env.VOLUTE_SESSION is set by the router, but the codex sandbox doesn't inherit it.
    try {
      const zshenvPath = resolvePath(options.cwd, ".zshenv");
      let existing: string;
      try {
        existing = readFileSync(zshenvPath, "utf-8");
      } catch {
        // .zshenv doesn't exist (non-codex template) — not critical
        existing = "";
      }
      if (existing) {
        const sessionLine = `export VOLUTE_SESSION=${JSON.stringify(session.name)}`;
        const updated = existing.replace(/^export VOLUTE_SESSION=.*$/m, sessionLine);
        if (updated === existing && !existing.includes("VOLUTE_SESSION")) {
          writeFileSync(zshenvPath, `${existing.trimEnd()}\n${sessionLine}\n`);
        } else if (updated !== existing) {
          writeFileSync(zshenvPath, updated);
        }
      }
    } catch (err) {
      warn("mind", `session "${session.name}": failed to sync VOLUTE_SESSION to .zshenv:`, err);
    }

    try {
      const { events } = await session.thread.runStreamed(text, {
        signal: session.abortController.signal,
      });

      // Track text deltas per item for streaming
      const itemText = new Map<string, string>();
      // Track file paths for auto-commit and identity reload
      const changedFiles: string[] = [];
      let needsReload = false;

      for await (const event of events) {
        try {
          switch (event.type) {
            case "thread.started": {
              // Save thread ID for session resume
              const threadId = event.thread_id ?? event.threadId ?? event.thread?.id;
              if (threadId && !session.name.startsWith("new-")) {
                sessionStore.save(session.name, threadId);
                log("mind", `session "${session.name}": saved thread ${threadId}`);
              }
              break;
            }

            case "item.started": {
              const item = event.item;
              if (!item) break;

              if (item.type === "agent_message" || item.type === "agentMessage") {
                itemText.set(event.itemId ?? item.id, "");
              } else if (item.type === "reasoning") {
                // Reasoning text may arrive on started or completed
                const text = item.text ?? item.content ?? "";
                if (text) emit(session, { type: "thinking", content: text });
              } else if (item.type === "command_execution" || item.type === "commandExecution") {
                const cmd = item.command ?? item.args?.join(" ") ?? "";
                emit(session, {
                  type: "tool_use",
                  content: JSON.stringify({ command: cmd }),
                  metadata: { name: "command" },
                });
                broadcast(session, {
                  type: "tool_use",
                  name: "command",
                  input: { command: cmd },
                });
              } else if (item.type === "file_change" || item.type === "fileChange") {
                const filePath = item.path ?? item.filePath ?? "";
                emit(session, {
                  type: "tool_use",
                  content: JSON.stringify({ path: filePath }),
                  metadata: { name: "file_change" },
                });
                broadcast(session, {
                  type: "tool_use",
                  name: "file_change",
                  input: { path: filePath },
                });
              } else if (item.type === "mcp_tool_call" || item.type === "mcpToolCall") {
                const toolName = `mcp:${item.serverName ?? ""}/${item.toolName ?? item.name ?? ""}`;
                emit(session, {
                  type: "tool_use",
                  content: JSON.stringify(item.input ?? item.arguments ?? {}),
                  metadata: { name: toolName },
                });
                broadcast(session, {
                  type: "tool_use",
                  name: toolName,
                  input: item.input ?? item.arguments ?? {},
                });
              } else if (item.type === "web_search" || item.type === "webSearch") {
                emit(session, {
                  type: "tool_use",
                  content: JSON.stringify({ query: item.query ?? "" }),
                  metadata: { name: "web_search" },
                });
                broadcast(session, {
                  type: "tool_use",
                  name: "web_search",
                  input: { query: item.query ?? "" },
                });
              }
              break;
            }

            case "item.updated": {
              const item = event.item;
              if (!item) break;
              const itemType = item.type;
              if (itemType === "agent_message" || itemType === "agentMessage") {
                const id = event.itemId ?? item.id;
                const prev = itemText.get(id) ?? "";
                const full = item.content ?? item.text ?? "";
                if (full.length > prev.length) {
                  const delta = full.slice(prev.length);
                  itemText.set(id, full);
                  broadcast(session, { type: "text", content: delta });
                  emit(session, { type: "text", content: delta });
                }
              }
              break;
            }

            case "item.completed": {
              const item = event.item;
              if (!item) break;
              const itemType = item.type;

              if (itemType === "reasoning") {
                const text = item.text ?? item.content ?? "";
                if (text) emit(session, { type: "thinking", content: text });
              } else if (itemType === "agent_message" || itemType === "agentMessage") {
                // Emit any remaining delta
                const id = event.itemId ?? item.id;
                const prev = itemText.get(id) ?? "";
                const full = item.content ?? item.text ?? "";
                if (full.length > prev.length) {
                  const delta = full.slice(prev.length);
                  broadcast(session, { type: "text", content: delta });
                  emit(session, { type: "text", content: delta });
                }
                itemText.delete(id);
              } else if (itemType === "command_execution" || itemType === "commandExecution") {
                const rawOutput = item.aggregated_output ?? item.output;
                const output =
                  typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput ?? "");
                const exitCode = item.exit_code ?? item.exitCode;
                emit(session, {
                  type: "tool_result",
                  content: output,
                  metadata: { name: "command", is_error: exitCode !== 0 },
                });
                broadcast(session, {
                  type: "tool_result",
                  output,
                  is_error: exitCode !== 0,
                });
              } else if (itemType === "file_change" || itemType === "fileChange") {
                const filePath = item.path ?? item.filePath ?? "";
                if (filePath) {
                  changedFiles.push(filePath);
                  trackFileChange(filePath, options.cwd);
                  // Check for identity files
                  if (/\b(SOUL|MEMORY|VOLUTE)\.md$/.test(filePath)) {
                    needsReload = true;
                  }
                }
                emit(session, {
                  type: "tool_result",
                  content: item.diff ?? `changed: ${filePath}`,
                  metadata: { name: "file_change" },
                });
                broadcast(session, {
                  type: "tool_result",
                  output: item.diff ?? `changed: ${filePath}`,
                });
              } else if (itemType === "mcp_tool_call" || itemType === "mcpToolCall") {
                const output =
                  typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
                emit(session, {
                  type: "tool_result",
                  content: output,
                  metadata: {
                    name: `mcp:${item.serverName ?? ""}/${item.toolName ?? item.name ?? ""}`,
                  },
                });
                broadcast(session, { type: "tool_result", output });
              } else if (itemType === "web_search" || itemType === "webSearch") {
                emit(session, {
                  type: "tool_result",
                  content: "search completed",
                  metadata: { name: "web_search" },
                });
                broadcast(session, { type: "tool_result", output: "search completed" });
              }
              break;
            }

            case "turn.completed": {
              const usage = event.usage;
              if (usage) {
                const inputTokens = usage.input_tokens ?? usage.inputTokens ?? 0;
                const outputTokens = usage.output_tokens ?? usage.outputTokens ?? 0;
                session.cumulativeInputTokens = inputTokens;
                broadcast(session, {
                  type: "usage",
                  input_tokens: inputTokens,
                  output_tokens: outputTokens,
                });
                emit(session, {
                  type: "usage",
                  metadata: { input_tokens: inputTokens, output_tokens: outputTokens },
                });
              }
              break;
            }
          }
        } catch (err) {
          warn("mind", `session "${session.name}": event handler error (${event?.type}):`, err);
        }
      }

      // Turn complete — flush file changes
      await flushFileChanges(options.cwd);

      // Identity reload
      if (needsReload) {
        log("mind", `session "${session.name}": identity file changed, requesting restart`);
        daemonRestart({ type: "reload" }).catch((err) => log("mind", "daemonRestart failed:", err));
      }

      // Compaction warning — actual compaction is handled by the Codex SDK via model_auto_compact_token_limit
      if (maxContextTokens && session.cumulativeInputTokens >= maxContextTokens) {
        log(
          "mind",
          `session "${session.name}": ${session.cumulativeInputTokens} tokens >= ${maxContextTokens} — SDK auto-compaction will handle`,
        );
      }

      log("mind", `session "${session.name}": turn done`);
    } catch (err: any) {
      if (err?.name === "AbortError") {
        log("mind", `session "${session.name}": turn aborted`);
      } else {
        warn("mind", `session "${session.name}": turn failed:`, err);
      }
    }

    broadcast(session, { type: "done" });
    emit(session, { type: "done" });

    if (session.currentMessageId) {
      session.messageChannels.delete(session.currentMessageId);
    }
    session.currentMessageId = undefined;
  }

  // --- Message queue processing ---

  async function processQueue(session: CodexSession) {
    if (session.processing) return;
    session.processing = true;

    while (session.messageQueue.length > 0) {
      const next = session.messageQueue.shift()!;
      session.currentMessageId = next.meta.messageId;
      await runTurn(session, next.text, next.meta);
    }

    session.processing = false;
  }

  // --- MessageHandler implementation ---

  function createSessionHandler(sessionName: string): MessageHandler {
    return {
      handle(content: VoluteContentPart[], meta: HandlerMeta, listener: Listener): () => void {
        const session = getOrCreateSession(sessionName);

        const filteredListener: Listener = (event) => {
          if (event.messageId === meta.messageId) listener(event);
        };
        session.listeners.add(filteredListener);

        // Track channel for reply instructions
        if (meta.channel) {
          session.messageChannels.set(meta.messageId, meta.channel);
        }

        const text = extractText(content);

        if (meta.interrupt && session.processing) {
          // Abort current turn and push interrupting message to front
          session.abortController?.abort();
          session.messageQueue.unshift({ text, meta });
        } else {
          session.messageQueue.push({ text, meta });
        }

        processQueue(session).catch((err) => {
          warn("mind", `session "${sessionName}": queue processing failed:`, err);
          broadcast(session, { type: "done" });
        });

        return () => session.listeners.delete(filteredListener);
      },
    };
  }

  // --- HandlerResolver ---

  const handlers = new Map<string, MessageHandler>();

  function resolve(sessionName: string): MessageHandler {
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

  const CHARS_PER_TOKEN = 3.5;
  function getContextInfo(): ContextInfo {
    const sizes = getSystemPromptSizes();
    const toTokens = (chars: number) => Math.round(chars / CHARS_PER_TOKEN);
    const systemPromptTokens = toTokens(sizes.soul + sizes.volute + sizes.memory);
    const skills = getSkillsSizes(resolvePath(options.cwd, ".claude/skills"));

    return {
      sessions: Array.from(sessions.values()).map((s) => {
        // Try to get accurate context from Codex JSONL
        const threadId = sessionStore.load(s.name);
        const jsonlPath = threadId ? findCodexSessionFile(threadId) : null;
        const parsed = jsonlPath
          ? parseCodexSessionJSONL(jsonlPath, systemPromptTokens, skills.total)
          : null;

        return {
          name: s.name,
          contextTokens: parsed?.contextTokens ?? s.cumulativeInputTokens,
          contextWindow: parsed?.contextWindow,
          breakdown: parsed?.breakdown,
        };
      }),
      systemPrompt: {
        total: systemPromptTokens,
        components: {
          soul: toTokens(sizes.soul),
          volute: toTokens(sizes.volute),
          memory: toTokens(sizes.memory),
        },
      },
      skills,
    };
  }

  return { resolve, getContextInfo };
}
