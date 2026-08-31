import { readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { Codex } from "@openai/codex-sdk";
import { flushFileChanges, trackFileChange } from "./lib/auto-commit.js";
import {
  DEFAULT_SEED_TOKENS,
  rotateCodexSession,
  seedCodexSession,
} from "./lib/codex-session-seed.js";
import { extractText } from "./lib/content.js";
import {
  countSdkInstructionTokens,
  countSkillDescriptionTokens,
  countSystemPromptTokens,
  findCodexSessionFile,
  getCachedContextInfo,
  processCodexSession,
  readSdkInstructions,
  readSkillDescriptions,
} from "./lib/context-breakdown.js";
import { daemonEmit, daemonRestart, type EventType } from "./lib/daemon-client.js";
import { runHooks } from "./lib/hook-loader.js";
import { log, warn } from "./lib/logger.js";
import { buildSeededNote, type SeedCause } from "./lib/seed-note.js";
import { createSessionStore } from "./lib/session-store.js";
import { getStartupContext, loadPrompts, loadSystemPrompt } from "./lib/startup.js";
import { filterEvent, loadTransparencyPreset } from "./lib/transparency.js";
import { turnContextFor } from "./lib/turn-context.js";
import type {
  HandlerMeta,
  HandlerResolver,
  Listener,
  MessageHandler,
  VoluteContentPart,
  VoluteEvent,
} from "./lib/types.js";
import { type UsageSnapshot, usageDelta, ZERO_USAGE } from "./lib/usage.js";
import type { ContextInfo, ContextMessages, SessionContextInfo } from "./lib/volute-server.js";

/** Minimal interface for a Codex SDK thread — typed to the methods we actually use */
type CodexThread = {
  runStreamed(
    text: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ events: AsyncIterable<Record<string, any>> }>;
};

type QueuedMessage = { text: string; meta: HandlerMeta };

type CodexSession = {
  name: string;
  thread: CodexThread | null;
  listeners: Set<Listener>;
  currentMessageId?: string;
  messageQueue: QueuedMessage[];
  processing: boolean;
  abortController?: AbortController;
  messageChannels: Map<string, string>;
  firstMessagePerChannel: Set<string>;
  /** The event note is a standing fact about events, so it fires once per session. */
  eventNoteFired: boolean;
  cumulativeInputTokens: number;
  /** Last cumulative usage snapshot from `turn.completed`, for per-turn deltas (see lib/usage.ts). */
  lastUsage: UsageSnapshot;
  /**
   * True when this session was seeded from a previous session's rollout (a restart
   * restore) or a rotation. Consumed once, on the first turn, to inject the note.
   */
  seeded: boolean;
  /** When the seeded-from session was archived (epoch ms), for the gap note; null if unknown. */
  seededArchivedAt: number | null;
  /**
   * The live Codex thread id, tracked in-memory (from thread.started) so rotation can
   * locate the rollout even for ephemeral `new-*` sessions, which persist no pointer.
   */
  currentThreadId: string | null;
  /** Why the tail is seeded — picks the boundary note's wording. Last cause wins. */
  seededCause: SeedCause;
  /**
   * Back-to-back rotations that did NOT bring context under the threshold (reset by any
   * healthy turn). Guards against a runaway loop when the tail alone can't fit — e.g. a
   * system prompt (large MEMORY.md) that already fills most of the window, which rotation
   * can't trim. Past the cap we stop rotating and defer to the SDK's native backstop.
   */
  consecutiveRotations: number;
};

/** Stop self-rotating after this many back-to-back rotations that didn't reduce context. */
const MAX_CONSECUTIVE_ROTATIONS = 3;

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
  /** Estimated-token budget for seeding a fresh persistent session. 0 disables. Default 30000. */
  seedTokens?: number;
}): {
  resolve: HandlerResolver;
  getContextInfo: () => Promise<ContextInfo>;
  getContextMessages: () => Promise<ContextMessages>;
} {
  const sessions = new Map<string, CodexSession>();
  const prompts = loadPrompts();
  const maxContextTokens = options.maxContextTokens;
  const seedTokens = options.seedTokens ?? DEFAULT_SEED_TOKENS;

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
      // Rotation is the primary path: at maxContextTokens we silently rotate onto the
      // verbatim tail between turns. The SDK's native auto-compaction is only an emergency
      // backstop — set above the volute threshold (1.5×) so it fires solely when rotation
      // can't relieve context (e.g. a system prompt too large to fit the tail under the
      // threshold), after the runaway guard stops self-rotating.
      model_auto_compact_token_limit: maxContextTokens
        ? Math.floor(maxContextTokens * 1.5)
        : 999999999,
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
      eventNoteFired: false,
      cumulativeInputTokens: 0,
      lastUsage: ZERO_USAGE,
      seeded: false,
      seededArchivedAt: null,
      currentThreadId: null,
      seededCause: "restored",
      consecutiveRotations: 0,
    };
    sessions.set(name, session);

    initSession(session);
    return session;
  }

  /** Thread options shared by startThread, resumeThread, and rotation resume. */
  function threadOptions() {
    return {
      workingDirectory: options.cwd,
      model: options.model,
      modelReasoningEffort: options.reasoningEffort,
      skipGitRepoCheck: true,
      // Codex's native seatbelt sandbox panics on macOS due to a bug in the
      // system-configuration Rust crate (SCDynamicStore NULL object). Use full
      // access until upstream ships a fix (mullvad/system-configuration-rs#59).
      sandboxMode: "danger-full-access" as const,
      networkAccessEnabled: true,
    };
  }

  function initSession(session: CodexSession) {
    const isEphemeral = session.name.startsWith("new-");
    log("mind", `session "${session.name}": ${isEphemeral ? "ephemeral" : "persistent"}`);
    emit(session, { type: "session_start" });

    if (!isEphemeral) {
      let resumeThreadId = sessionStore.load(session.name);
      if (!resumeThreadId) {
        // Fresh persistent session — seed it from the previous session's archived
        // rollout so the mind experiences the conversation continuing rather than
        // waking into an empty context.
        const seeded = seedCodexSession({
          mindDir: options.mindDir,
          name: session.name,
          seedTokens,
        });
        if (seeded) {
          resumeThreadId = seeded.threadId;
          session.seeded = true;
          session.seededArchivedAt = seeded.archivedAt;
          session.seededCause = "restored";
          log("mind", `session "${session.name}": seeded from previous transcript`);
        }
      }
      if (resumeThreadId) {
        try {
          log("mind", `session "${session.name}": resuming thread ${resumeThreadId}`);
          session.thread = codex.resumeThread(resumeThreadId, threadOptions());
          session.currentThreadId = resumeThreadId;
          return;
        } catch (err) {
          warn("mind", `session "${session.name}": failed to resume thread, starting new:`, err);
          // We fell back to a truly fresh thread — don't tell the mind its
          // conversation continued when the seeded rollout failed to resume.
          session.seeded = false;
        }
      }
    }

    try {
      session.thread = codex.startThread(threadOptions());
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

    // On the first turn of a seeded session, prepend the honest-boundary note
    // (consumed once) so the mind knows the tail above was restored (restart) or
    // rotated (context limit). The restored note carries a coarse gap-duration
    // clause when the archive time is known; the rotation note has no gap clause.
    if (session.seeded) {
      session.seeded = false;
      const note = buildSeededNote({
        cause: session.seededCause,
        archivedAtMs: session.seededArchivedAt,
      });
      emit(session, {
        type: "context",
        content: note,
        metadata: { source: "seeded-session" },
      });
      text = `${note}\n\n${text}`;
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

    // Either the system-event note or reply instructions — never both, and never reply
    // instructions on an event turn. See turn-context.ts for the rule and why it matters.
    const turnContext = turnContextFor(meta, session, prompts);
    if (turnContext) {
      emit(session, {
        type: "context",
        content: turnContext.content,
        metadata: { source: turnContext.source },
      });
      text = `${turnContext.content}\n\n${text}`;
    }

    session.abortController = new AbortController();

    // Sync VOLUTE_SESSION to .zshenv so codex shell commands know which session they're in.
    // The codex sandbox doesn't pass env through, so this file is the only carrier — and it
    // is still last-writer-wins across sessions, unlike the claude template's per-stream env.
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
              // Track the live thread id in-memory (used by rotation) and persist it for
              // resume — persistent sessions only; ephemeral `new-*` keep no pointer.
              const threadId = event.thread_id ?? event.threadId ?? event.thread?.id;
              if (threadId) {
                session.currentThreadId = threadId;
                if (!session.name.startsWith("new-")) {
                  sessionStore.save(session.name, threadId);
                  log("mind", `session "${session.name}": saved thread ${threadId}`);
                }
              }
              break;
            }

            case "item.started": {
              const item = event.item;
              if (!item) break;
              // Stable per-item id so a tool_result links to its own tool_use (see
              // item.completed). Codex reuses this id across the item's start/end events.
              const itemId = event.itemId ?? item.id;

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
                  metadata: { name: "command", id: itemId },
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
                  metadata: { name: "file_change", id: itemId },
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
                  metadata: { name: toolName, id: itemId },
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
                  metadata: { name: "web_search", id: itemId },
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
              // Same id emitted on item.started, so the daemon links this result to its tool_use.
              const itemId = event.itemId ?? item.id;

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
                  metadata: { name: "command", is_error: exitCode !== 0, tool_use_id: itemId },
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
                  metadata: { name: "file_change", tool_use_id: itemId },
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
                    tool_use_id: itemId,
                  },
                });
                broadcast(session, { type: "tool_result", output });
              } else if (itemType === "web_search" || itemType === "webSearch") {
                emit(session, {
                  type: "tool_result",
                  content: "search completed",
                  metadata: { name: "web_search", tool_use_id: itemId },
                });
                broadcast(session, { type: "tool_result", output: "search completed" });
              }
              break;
            }

            case "turn.completed": {
              const usage = event.usage;
              if (usage) {
                // codex's usage is cumulative over the whole thread — the per-turn cost is
                // the difference from the last snapshot (see lib/usage.ts).
                const delta = usageDelta(session.lastUsage, usage);
                if (delta) {
                  session.lastUsage = delta.next;
                  // Kept cumulative: this feeds the rotation threshold, not the bill.
                  session.cumulativeInputTokens = delta.next.input;
                  const payload = { ...delta.payload, model: options.model };
                  broadcast(session, { type: "usage", ...payload });
                  emit(session, { type: "usage", metadata: payload });
                }
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

  // --- Rotation (silent, at turn end) ---

  /**
   * Rotate the thread in place: build a seeded budget-tail rollout out of the live
   * rollout, archive the rotated-out thread, and resume the new thread. On any failure
   * we leave the old thread in place and let the SDK's native backstop handle it if
   * context keeps climbing.
   */
  function performRotation(session: CodexSession) {
    const oldThreadId = session.currentThreadId;

    const newThreadId = oldThreadId
      ? rotateCodexSession({
          mindDir: options.mindDir,
          name: session.name,
          oldThreadId,
          seedTokens,
        })
      : null;
    if (!newThreadId) {
      log("mind", `session "${session.name}": rotation failed, deferring to SDK backstop`);
      return;
    }

    try {
      session.thread = codex.resumeThread(newThreadId, threadOptions());
    } catch (err) {
      warn("mind", `session "${session.name}": failed to resume rotated thread:`, err);
      return; // keep the old thread; the SDK backstop covers a runaway
    }
    session.currentThreadId = newThreadId;
    if (!session.name.startsWith("new-")) sessionStore.save(session.name, newThreadId);
    // Fresh thread — reset token tracking (the next turn.completed sets the real value)
    // and arm the rotation-cause boundary note for the mind's next turn.
    session.cumulativeInputTokens = 0;
    session.lastUsage = ZERO_USAGE;
    session.seeded = true;
    session.seededCause = "rotation";
    session.seededArchivedAt = null;
    // Count this rotation; a healthy turn resets it. If back-to-back rotations don't
    // reduce context (system prompt too large to fit the tail), the cap stops the loop.
    session.consecutiveRotations++;
    if (session.consecutiveRotations >= MAX_CONSECUTIVE_ROTATIONS) {
      log(
        "mind",
        `session "${session.name}": ${session.consecutiveRotations} rotations without relief — deferring further compaction to the SDK (system prompt likely too large)`,
      );
    }
    log("mind", `session "${session.name}": rotated to ${newThreadId}`);
  }

  /**
   * Decide, after a turn, whether to rotate in place: only when a threshold is
   * configured, context is at/over it, and we're under the runaway cap (past the
   * cap, the SDK's native backstop takes over). A turn that came back under the
   * threshold ends any streak. Rotation is silent — the one-line rotation note
   * arms via seededCause and lands on the next turn.
   */
  function maybeRotate(session: CodexSession) {
    if (!maxContextTokens) return;
    if (session.cumulativeInputTokens < maxContextTokens) {
      session.consecutiveRotations = 0; // healthy turn — streak over
      return;
    }
    if (session.consecutiveRotations >= MAX_CONSECUTIVE_ROTATIONS) return;
    log(
      "mind",
      `session "${session.name}": ${session.cumulativeInputTokens} tokens >= ${maxContextTokens} — rotating`,
    );
    performRotation(session);
  }

  // --- Message queue processing ---

  async function processQueue(session: CodexSession) {
    if (session.processing) return;
    session.processing = true;

    while (session.messageQueue.length > 0) {
      const next = session.messageQueue.shift()!;
      session.currentMessageId = next.meta.messageId;
      await runTurn(session, next.text, next.meta);
      // Post-turn is between-turns for the queue, so rotate here if we're over.
      maybeRotate(session);
    }

    session.processing = false;
  }

  // --- MessageHandler implementation ---

  function createSessionHandler(sessionName: string): MessageHandler {
    return {
      handle(content: VoluteContentPart[], meta: HandlerMeta, listener?: Listener): () => void {
        const session = getOrCreateSession(sessionName);

        // Only register a listener when a caller wants events. A per-message listener
        // that's never removed grows session.listeners without bound and makes broadcast
        // O(messages-ever-received). The live dispatch path passes no listener.
        let filteredListener: Listener | undefined;
        if (listener) {
          filteredListener = (event) => {
            if (event.messageId !== meta.messageId) return;
            listener(event);
            if (event.type === "done" && filteredListener) {
              session.listeners.delete(filteredListener);
            }
          };
          session.listeners.add(filteredListener);
        }

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

        return () => {
          if (filteredListener) session.listeners.delete(filteredListener);
        };
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

  const systemPromptTokens = countSystemPromptTokens(options.systemPrompt);
  const claudeMdTokens = countSdkInstructionTokens(options.cwd);
  const skillDescTokens = countSkillDescriptionTokens([resolvePath(options.cwd, ".agents/skills")]);

  function jsonlPathFor(sessionName: string): string | null {
    const threadId = sessionStore.load(sessionName);
    return threadId ? findCodexSessionFile(threadId, options.mindDir) : null;
  }

  async function getContextInfo(): Promise<ContextInfo> {
    const infos: SessionContextInfo[] = [];
    for (const s of sessions.values()) {
      try {
        const jsonlPath = jsonlPathFor(s.name);
        // Cache the computed breakdown by file identity: polls between turns are free.
        const parsed = jsonlPath
          ? await getCachedContextInfo(
              jsonlPath,
              async () =>
                (
                  await processCodexSession(
                    jsonlPath,
                    systemPromptTokens,
                    claudeMdTokens,
                    skillDescTokens,
                  )
                ).parsed,
            )
          : null;
        infos.push({
          name: s.name,
          contextTokens: parsed?.contextTokens ?? s.cumulativeInputTokens,
          contextWindow: maxContextTokens,
          breakdown: parsed?.breakdown,
        });
      } catch (err) {
        log("mind", `failed to get context breakdown for session "${s.name}":`, err);
        infos.push({
          name: s.name,
          contextTokens: s.cumulativeInputTokens,
          contextWindow: maxContextTokens,
        });
      }
    }
    return { sessions: infos, systemPrompt: systemPromptTokens };
  }

  async function getContextMessages(): Promise<ContextMessages> {
    const skillsDir = resolvePath(options.cwd, ".agents/skills");
    const sessionMessages: ContextMessages["sessions"] = [];
    for (const s of sessions.values()) {
      try {
        const jsonlPath = jsonlPathFor(s.name);
        const result = jsonlPath
          ? await processCodexSession(
              jsonlPath,
              systemPromptTokens,
              claudeMdTokens,
              skillDescTokens,
            )
          : null;
        sessionMessages.push({ name: s.name, messages: result?.messages ?? [] });
      } catch (err) {
        log("mind", `failed to extract messages for session "${s.name}":`, err);
        sessionMessages.push({ name: s.name, messages: [] });
      }
    }
    return {
      preamble: {
        systemPrompt: options.systemPrompt,
        sdkInstructions: readSdkInstructions(options.cwd),
        skillDescriptions: readSkillDescriptions([skillsDir]),
      },
      sessions: sessionMessages,
    };
  }

  // Pre-warm the main session so the thread is created immediately
  // instead of waiting for the first message.
  getOrCreateSession("main");

  return { resolve, getContextInfo, getContextMessages };
}
