import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { extractImages, extractText } from "./lib/content.js";
import {
  countSdkInstructionTokens,
  countSkillDescriptionTokens,
  countSystemPromptTokens,
  findPiSessionFile,
  getCachedContextInfo,
  processPiSession,
  readSdkInstructions,
  readSkillDescriptions,
} from "./lib/context-breakdown.js";
import { daemonEmit, daemonNotice } from "./lib/daemon-client.js";
import { dispatchPrompt } from "./lib/dispatch.js";
import { createEventHandler, emit } from "./lib/event-handler.js";
import { runHooks } from "./lib/hook-loader.js";
import { createIdentityWatch } from "./lib/identity-watch.js";
import { log } from "./lib/logger.js";
import { DEFAULT_SEED_TOKENS, rotatePiSession, seedPiSession } from "./lib/pi-session-seed.js";
import { createReplyInstructionsExtension } from "./lib/reply-instructions-extension.js";
import { resolveModel } from "./lib/resolve-model.js";
import { buildSeededNote, type SeedCause } from "./lib/seed-note.js";
import { createSessionBashTool } from "./lib/session-bash.js";
import { clearCommitted, isCommitted, markCommitted, threadRef } from "./lib/session-marker.js";
import { getStartupContext, loadPrompts, type SubagentConfig } from "./lib/startup.js";
import { createSubagentExtension, type SubagentDefinition } from "./lib/subagents.js";
import type {
  HandlerMeta,
  HandlerResolver,
  Listener,
  MessageHandler,
  UsageByModel,
  VoluteContentPart,
  VoluteEvent,
} from "./lib/types.js";
import type { ContextInfo, ContextMessages, SessionContextInfo } from "./lib/volute-server.js";

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
  /** Why the session failed to start, for the messages that were waiting on it. */
  initError?: unknown;
  /** Prompts handed to pi and not yet resolved — an ephemeral session is evicted at 0. */
  inFlight: number;
  /** Subagent usage for the current turn — see EventSession.subagentUsage. */
  subagentUsage: UsageByModel[];
  /**
   * True when this session was seeded from the previous session's transcript. Injects
   * the honest-boundary note, and is cleared only once a turn has settled — a turn
   * that never ran re-offers it rather than losing it (matching claude).
   */
  seeded?: boolean;
  /** When the seeded-from session was archived (epoch ms), for the gap note; null if unknown. */
  seededArchivedAt?: number | null;
  /** Why the tail is seeded — picks the boundary note's wording. Last cause wins. */
  seededCause?: SeedCause;
  /**
   * Set after an in-place rotation so the mind is told, on its next turn, that the
   * session rotated at the context limit. Delivered separately from the restored-seed
   * note (which fires only on the first turn of a freshly created agent session).
   */
  rotationNotePending?: boolean;
  /**
   * Back-to-back rotations that did NOT bring context under the threshold (reset by
   * any healthy turn). Guards against a runaway loop when the tail alone can't fit —
   * e.g. a system prompt (large MEMORY.md) that already fills most of the window,
   * which rotation can't trim. Past the cap we defer to the SDK's native compaction.
   */
  consecutiveRotations?: number;
};

/** Stop self-rotating after this many back-to-back rotations that didn't reduce context. */
const MAX_CONSECUTIVE_ROTATIONS = 3;

export async function createMind(options: {
  systemPrompt: string;
  cwd: string;
  mindDir: string;
  /** Directory holding pi session subdirs (`<sessionsDir>/<name>/*.jsonl`). */
  sessionsDir: string;
  model?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  maxContextTokens?: number;
  /** Estimated-token budget for seeding a fresh persistent session. 0 disables. Default 30000. */
  seedTokens?: number;
  subagents?: Record<string, SubagentConfig>;
  /**
   * Called at the end of a turn in which the mind edited its own SOUL.md, MEMORY.md or
   * VOLUTE.md (#998). The system prompt is composed once, at startup, so the edit is
   * inert until the process restarts — the server answers this by restarting.
   */
  onIdentityReload?: () => void | Promise<void>;
  /** The model runtime to use instead of creating one — lets tests supply a fake provider. */
  modelRuntime?: ModelRuntime;
}): Promise<{
  resolve: HandlerResolver;
  getContextInfo: () => Promise<ContextInfo>;
  getContextMessages: () => Promise<ContextMessages>;
}> {
  const sessions = new Map<string, PiSession>();
  // One watch per process, matching the claude template: the latch inside it means a
  // failed restart doesn't re-fire on every later turn of every session.
  const identityWatch = createIdentityWatch(options.cwd);
  const prompts = loadPrompts();
  const compactionInstructions = prompts.compaction_instructions;
  const maxContextTokens = options.maxContextTokens;
  const seedTokens = options.seedTokens ?? DEFAULT_SEED_TOKENS;

  if (maxContextTokens) {
    log("mind", `compaction threshold: ${maxContextTokens} tokens`);
  }

  // Shared setup (created once)
  const modelStr = options.model || process.env.PI_MODEL || "anthropic:claude-sonnet-4-20250514";
  // ModelRuntime is the canonical model/auth object since pi-coding-agent 0.84;
  // it owns the credential store that AuthStorage used to be. ModelRegistry is now
  // a thin synchronous facade over it, kept here for the find() lookup below.
  const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create());
  const modelRegistry = new ModelRegistry(modelRuntime);
  // Prefer the registry's model: for OAuth providers with a per-credential baseUrl
  // (e.g. GitHub Copilot, whose token is pinned to an individual/business/enterprise
  // proxy host) it has already run the provider's modifyModels() patch. The static
  // catalog lookup in resolveModel() has no way to apply that and would send every
  // request to the wrong host, which the provider's API rejects (421 Misdirected
  // Request for Copilot). Fall back to resolveModel() for ids the registry doesn't
  // carry (e.g. an admin-registered custom id not yet in the built-in catalog).
  const [modelProvider, ...modelRest] = modelStr.split(":");
  const model = modelRegistry.find(modelProvider, modelRest.join(":")) ?? resolveModel(modelStr);

  // The daemon centrally refreshes the system OAuth token and rewrites auth.json,
  // and a running mind adopts it without a restart. Up to pi-coding-agent 0.80
  // that needed a watchFile + authStorage.reload() here; since 0.84 the credential
  // store compares auth.json's file revision on every read and reloads itself when
  // it moves, so a watcher would only duplicate work the next read already does.

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

      pi.on("before_agent_start", async (event) => {
        const parts: string[] = [];

        // On a seeded session, lead with the honest-boundary note so the restored
        // transcript above isn't mistaken for a continuously-lived conversation. Not
        // cleared here: this is only dispatch, and a turn that never runs would lose the
        // note forever and invisibly. It's cleared when a turn settles; worst case the
        // note is offered twice (cosmetic) rather than never.
        if (session.seeded) {
          const note = buildSeededNote({
            cause: "restored",
            archivedAtMs: session.seededArchivedAt ?? null,
          });
          emit(session, {
            type: "context",
            content: note,
            metadata: { source: "seeded-session" },
          });
          parts.push(note);
        }

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

        // On the first turn after an in-place rotation, tell the mind the earlier
        // turns collapsed at the context limit (distinct from the restored-seed note,
        // which only fires on a freshly created agent session). Consumed once.
        if (session.rotationNotePending) {
          session.rotationNotePending = false;
          const note = buildSeededNote({ cause: "rotation" });
          emit(session, {
            type: "context",
            content: note,
            metadata: { source: "seeded-session" },
          });
          parts.push(note);
        }

        try {
          const result = await runHooks(hooksDir, "pre-prompt", {
            event: "pre-prompt",
            session: session.name,
            prompt: event.prompt,
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
            session: session.name,
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
      inFlight: 0,
      subagentUsage: [],
    };
    sessions.set(name, session);

    session.ready = initSession(session).catch((err) => {
      log("mind", `session "${session.name}": init failed:`, err);
      // The messages already waiting on this session each report the failure to the
      // daemon (see handle) — otherwise their turns never end and hold the mind's turn
      // slot. Evict it so the next message makes a fresh attempt instead of meeting
      // this dead entry for the life of the process.
      session.initError = err;
      session.messageChannels.clear();
      if (sessions.get(name) === session) sessions.delete(name);
    });
    return session;
  }

  /**
   * Tell the mind a thread started over without what it held. Mind-level (no `thread`):
   * a thread-scoped notice waits for a turn on that exact thread, which may be hours
   * away or never — the mind stays silently amnesiac meanwhile (#768).
   */
  function noticeContextLost(name: string, message: string) {
    daemonNotice({ kind: "context_lost", message }).catch((err) =>
      log("mind", `session "${name}": failed to record notice:`, err),
    );
  }

  async function initSession(session: PiSession) {
    const isEphemeral = session.name.startsWith("new-");
    const dir = resolvePath(options.sessionsDir, session.name);

    // Fresh persistent session — seed it from the previous session's archived
    // transcript so the mind experiences the conversation continuing rather than
    // waking into an empty context. seedPiSession no-ops when a live session
    // already exists (continueRecent will resume that instead). Ephemeral
    // `new-*` sessions are one-offs — they never seed at start.
    const seeded = isEphemeral
      ? null
      : seedPiSession({
          cwd: options.cwd,
          piSessionsDir: options.sessionsDir,
          name: session.name,
          seedTokens,
        });

    // Every session (ephemeral too) is file-backed under its own name-scoped dir,
    // so rotation applies uniformly at the context limit. Ephemerality is only that
    // `new-*` sessions never seed at start and never archive on rotation — not a
    // different backing store. Their unique `new-<ts>-<rand>` names mean the dir is
    // always fresh, so continueRecent starts them empty (no seed to adopt).
    let sessionManager = SessionManager.continueRecent(options.cwd, dir);
    // A session file already on disk is real conversation: pi writes one only after the
    // first assistant reply, and seeds and rotations write theirs with a tail. Absent,
    // continueRecent started an empty session.
    const resumed = existsSync(sessionManager.getSessionFile() ?? "");

    // Whether this thread is known to hold real conversation — see session-marker.ts.
    // Sticky; cleared only where the thread genuinely starts over.
    let committed = !isEphemeral && isCommitted(dir);
    if (!resumed && committed) {
      // The thread held conversation and there is none to resume: the transcripts are
      // gone, or no longer match (continueRecent matches them by the cwd in their
      // header, so a mind whose home path changed finds none).
      log("mind", `session "${session.name}": committed transcript not found, starting fresh`);
      noticeContextLost(
        session.name,
        `The previous session for ${threadRef(session.name)} couldn't be restored (no ` +
          "transcript for it was found), so it was reset. `volute mind history` has the " +
          "record of what you were doing.",
      );
      clearCommitted(dir);
      committed = false;
    }

    // If continueRecent adopted our seed file, its header id is the seeded id;
    // if it fell back to a truly fresh session it minted a different id, so the
    // honest-boundary note never lies about a conversation that didn't continue.
    if (seeded && sessionManager.getSessionId() === seeded.sessionId) {
      session.seeded = true;
      session.seededArchivedAt = seeded.archivedAt;
      session.seededCause = "restored";
      log("mind", `session "${session.name}": seeded from previous transcript`);
    }

    log("mind", `session "${session.name}": ${isEphemeral ? "ephemeral" : "persistent"}`);

    // Compaction is rotation (not SDK /compact), and it's silent: crossing the
    // threshold (onContextTokens) or a native PreCompact just sets rotatePending; the
    // session rotates in place once the run that crossed it has settled — no warning,
    // no wrap-up turn. The auto summarizer's turn summaries are the record of collapsed
    // turns, and the one-line rotation note marks the boundary on the next turn. Past
    // the runaway cap, the settle handler defers to the native compact() backstop instead.
    let compactBlocked = false;
    let manualCompactPending = false;
    let rotatePending = false;
    let compactionInProgress = false;
    // A rotation (or its fallback) ran since this run started — see onTurnEnd below.
    let rotatedThisRun = false;

    function resetCompactionState() {
      rotatePending = false;
      compactionInProgress = false;
    }

    /**
     * Rotate the session in place onto a synthetic session holding the verbatim recent
     * tail (the seedTokens-budget tail), then switch the running SessionManager to it.
     * Returns false if rotation can't proceed (session not ready, or the file build failed) so
     * the caller can fall back to a fresh session. The setSessionFile + refreshContext
     * pair is the load-bearing adoption step: the SessionManager is the canonical source
     * of provider context, and refreshContext re-projects the agent's public transcript
     * from it (assigning state.messages directly no longer changes what the mind sees).
     */
    function rotateInPlace(): boolean {
      const as = session.agentSession;
      const sourcePath = as?.sessionManager.getSessionFile();
      if (!as || !sourcePath) return false; // not ready — fall back to fresh
      const newPath = rotatePiSession({
        cwd: options.cwd,
        sessionsDir: options.sessionsDir,
        name: session.name,
        sourcePath,
        seedTokens,
      });
      if (!newPath) return false;
      as.sessionManager.setSessionFile(newPath);
      as.refreshContext();
      session.rotationNotePending = true;
      session.seededCause = "rotation";
      session.consecutiveRotations = (session.consecutiveRotations ?? 0) + 1;
      compactBlocked = false; // re-arm the native-compaction backstop
      log(
        "mind",
        `session "${session.name}": rotated in place → ${as.sessionManager.getSessionId()} (rotation ${session.consecutiveRotations})`,
      );
      return true;
    }

    /**
     * Rotation couldn't proceed — start a fresh session in place (new empty transcript,
     * cleared context), matching the claude template's rotation-failure fallback. Fresh
     * is a far smaller cliff now that seeding exists; crucially it is NOT a silent native
     * compaction. Unlike a rotation it genuinely loses the live context, so say so (#367).
     */
    function freshFallback() {
      const as = session.agentSession;
      if (as) {
        as.sessionManager.newSession();
        as.refreshContext();
      }
      session.consecutiveRotations = 0;
      compactBlocked = false;
      log("mind", `session "${session.name}": rotation failed, starting fresh`);
      if (committed) {
        noticeContextLost(
          session.name,
          `Session rotation failed at the context limit and ${threadRef(session.name)} ` +
            "was reset — the conversation before the reset was lost. Your turn " +
            "summaries survive in `volute mind history` — that's where you left off.",
        );
      }
      if (!isEphemeral) clearCommitted(dir);
      committed = false;
    }

    /**
     * The SDK's native compaction, used as the emergency backstop past the runaway cap —
     * when rotation can't relieve context (e.g. the system prompt alone fills most of the
     * window, so no tail fits under the threshold). The sole remaining use of the custom
     * compaction instructions.
     *
     * Called from the settle handler, so compact() itself is deferred out of it: pi awaits
     * extension handlers mid-settle, and compact() aborts and waits for idle. If a new run
     * started in between, compacting would abort it — leave the rotation pending instead.
     */
    function runBackstopCompact() {
      manualCompactPending = true;
      compactionInProgress = true;
      setImmediate(() => {
        const as = session.agentSession;
        if (!as || as.isStreaming) {
          manualCompactPending = false;
          compactionInProgress = false;
          rotatePending = true;
          return;
        }
        log("mind", `session "${session.name}": rotation cap reached — native compaction backstop`);
        Promise.resolve(as.compact(compactionInstructions))
          .catch((err) => log("mind", `session "${session.name}": backstop compact() failed:`, err))
          .finally(() => {
            compactionInProgress = false;
          });
      });
    }

    /**
     * A run has fully settled: pi has finished any retry, native-compaction check and
     * queued continuation, and nothing is streaming. This — not agent_end, which the
     * daemon's `done` follows, and after which a queued follow-up can still be streaming
     * in the same run — is the only point where swapping the session file can't land
     * under a live turn. It runs synchronously inside pi's settle emission, during which
     * a new prompt() is deferred until after it, so nothing can start mid-swap. (A
     * prompt() that entered before settle and is still in its pre-run awaits will run on
     * the rotated context — consistent, just without the rotation note until the next
     * turn.)
     */
    function onSettled() {
      try {
        const as = session.agentSession;
        // A turn resolved, so the seeded note's injection had its chance to land.
        session.seeded = false;
        // Its transcript is on disk now (pi writes the file at the first assistant
        // reply), so from here a missing transcript is a real loss.
        if (!committed && as && existsSync(as.sessionManager.getSessionFile() ?? "")) {
          committed = true;
          if (!isEphemeral) markCommitted(dir);
        }
        if (!rotatePending) {
          // A healthy turn (context under the threshold) — the rotation streak, if
          // any, is over, so re-arm the self-rotation cap.
          session.consecutiveRotations = 0;
          return;
        }
        rotatePending = false;
        rotatedThisRun = true;
        if ((session.consecutiveRotations ?? 0) >= MAX_CONSECUTIVE_ROTATIONS) {
          // Runaway guard: rotation isn't relieving context (system prompt too large to
          // fit the tail under the threshold) — defer to the SDK.
          runBackstopCompact();
        } else if (!rotateInPlace()) {
          // Rotation couldn't proceed — fresh session, not a silent native compaction.
          freshFallback();
        }
      } catch (err) {
        log("mind", `session "${session.name}": settle error, resetting compaction state:`, err);
        resetCompactionState();
        // Compaction state is unknown after a throw — hold the identity restart back.
        rotatedThisRun = true;
      }
    }

    const turnBoundaryExtension: ExtensionFactory = (pi) => {
      pi.on("agent_start", () => {
        rotatedThisRun = false;
      });
      pi.on("agent_settled", onSettled);
      pi.on("session_before_compact", () => {
        // Our own backstop compact() call (past the runaway cap) — allow through.
        if (manualCompactPending) {
          manualCompactPending = false;
          log("mind", `session "${session.name}": allowing native compaction backstop`);
          return;
        }

        // The SDK's native auto-compaction wants to fire. Converge it onto rotation:
        // the first pass marks the session for rotation once the run settles (unless the
        // threshold path already did, or the runaway cap is hit) and blocks the native
        // compaction; the second pass allows native compaction as the emergency
        // backstop (only reachable if rotation never brought context under control).
        if (!compactBlocked) {
          compactBlocked = true;
          if (
            !rotatePending &&
            !compactionInProgress &&
            (session.consecutiveRotations ?? 0) < MAX_CONSECUTIVE_ROTATIONS
          ) {
            log(
              "mind",
              `session "${session.name}": native compaction — rotation pending at turn end`,
            );
            rotatePending = true;
          } else {
            log("mind", `session "${session.name}": blocking native compaction (rotation pending)`);
          }
          return { cancel: true };
        }
        compactBlocked = false;
        log("mind", `session "${session.name}": allowing native compaction backstop`);
      });
    };

    async function startAgentSession(sessionManager: SessionManager): Promise<PiAgentSession> {
      const settingsManager = SettingsManager.inMemory({
        retry: { enabled: true, maxRetries: 3 },
      });

      const replyInstructionsExtension = createReplyInstructionsExtension(
        session.messageChannels,
        emit,
        session,
      );

      const dynamicHookExtension = createDynamicHookExtension(session);

      // Per session, so a subagent's commands carry the slug of the session that ran it.
      const subagentExtension =
        Object.keys(subagents).length > 0
          ? createSubagentExtension(subagents, {
              cwd: options.cwd,
              model,
              modelRuntime,
              sessionName: session.name,
              onUsage: (usage) => session.subagentUsage.push(usage),
            })
          : undefined;

      const resourceLoader = new DefaultResourceLoader({
        cwd: options.cwd,
        agentDir: getAgentDir(),
        settingsManager,
        systemPrompt: options.systemPrompt,
        extensionFactories: [
          turnBoundaryExtension,
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
        modelRuntime,
        sessionManager,
        settingsManager,
        resourceLoader,
        customTools: [createSessionBashTool(options.cwd, session.name, settingsManager)],
      });
      return agentSession;
    }

    let agentSession: PiAgentSession;
    try {
      agentSession = await startAgentSession(sessionManager);
    } catch (err) {
      // Only a resumed transcript is something a fresh start could get past; any other
      // failure would fail the same way again.
      if (!resumed) throw err;
      log("mind", `session "${session.name}": resume failed, starting fresh:`, err);
      // Don't tell the mind the conversation continued when it didn't.
      session.seeded = false;
      sessionManager = SessionManager.create(options.cwd, dir);
      agentSession = await startAgentSession(sessionManager);
      // Only once the fresh session is up: had it failed too, nothing was abandoned —
      // the old transcript is still the most recent, and the next message retries it.
      if (committed) {
        noticeContextLost(
          session.name,
          `${threadRef(session.name)} couldn't be resumed after an error, so it started ` +
            "fresh — the conversation before the reset was lost. `volute mind history` " +
            "has the record of what you were doing.",
        );
        clearCommitted(dir);
        committed = false;
      }
    }

    // Resumed cleanly: a transcript on disk is real conversation (see `resumed`). Marked
    // only now, so a transcript that can't be resumed is reported once, not per restart.
    if (!committed && !isEphemeral && existsSync(sessionManager.getSessionFile() ?? "")) {
      markCommitted(dir);
      committed = true;
    }

    session.agentSession = agentSession;

    session.unsubscribe = agentSession.subscribe(
      createEventHandler(session, {
        cwd: options.cwd,
        broadcast: (event) => broadcast(session, event),
        identityWatch,
        onIdentityReload: options.onIdentityReload,
        onContextTokens: (tokens: number) => {
          session.contextTokens = tokens;
          if (
            maxContextTokens &&
            tokens >= maxContextTokens &&
            !rotatePending &&
            !compactionInProgress &&
            (session.consecutiveRotations ?? 0) < MAX_CONSECUTIVE_ROTATIONS
          ) {
            log(
              "mind",
              `session "${session.name}": ${tokens} tokens >= ${maxContextTokens} — rotation pending at turn end`,
            );
            rotatePending = true;
          }
        },
        // True when this run is rotating (or has rotated) the session, which tells the
        // caller to hold back the identity-reload restart — it would land on top of the
        // session being rewritten in place.
        onTurnEnd: () => rotatePending || rotatedThisRun,
      }),
    );

    log("mind", `session "${session.name}": ready`);
  }

  /** Drop a finished ephemeral session: `new-*` names are never reused, so it only holds memory. */
  function evictEphemeral(session: PiSession) {
    const as = session.agentSession;
    if (session.inFlight > 0 || as?.isStreaming) return;
    if (sessions.get(session.name) !== session) return;
    sessions.delete(session.name);
    session.unsubscribe?.();
    as?.dispose();
    log("mind", `session "${session.name}": ephemeral session done, evicted`);
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
        session.inFlight++;
        (async () => {
          await session.ready;
          if (!session.agentSession) {
            // The session failed to start (and has been evicted). Fail this turn loudly
            // through the catch below rather than dropping the message with only a local
            // done: the daemon would never hear the turn ended.
            throw session.initError ?? new Error("session failed to start");
          }
          // This await is load-bearing: without it a prompt rejection (burst race,
          // auth failure, ...) floats as an unhandled rejection and crashes the
          // mind server instead of landing in the .catch below (issue #565).
          await dispatchPrompt(session.agentSession, text, opts, meta.interrupt === true, () =>
            interruptSession(sessionName),
          );
        })()
          .catch(async (err) => {
            log("mind", `session "${sessionName}": prompt failed:`, err);
            // Tell the daemon the turn failed (so it records a notice for the mind's next
            // successful turn) before done, then complete the turn locally and on the daemon.
            await daemonEmit({ type: "error", session: sessionName, content: String(err) }).catch(
              () => {},
            );
            await daemonEmit({ type: "done", session: sessionName }).catch(() => {});
            broadcast(session, { type: "done", messageId: meta.messageId });
          })
          .finally(() => {
            session.inFlight--;
            if (sessionName.startsWith("new-")) evictEphemeral(session);
          })
          .catch((err) => log("mind", `session "${sessionName}": post-turn error:`, err));

        return () => {
          if (filteredListener) session.listeners.delete(filteredListener);
        };
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

  async function getContextInfo(): Promise<ContextInfo> {
    const infos: SessionContextInfo[] = [];
    for (const s of sessions.values()) {
      try {
        const jsonlPath = findPiSessionFile(piSessionsDir, s.name);
        // Cache the computed breakdown by file identity: polls between turns are free.
        const parsed = jsonlPath
          ? await getCachedContextInfo(
              jsonlPath,
              async () =>
                (
                  await processPiSession(
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
          contextTokens: parsed?.contextTokens ?? s.contextTokens,
          contextWindow: maxContextTokens,
          breakdown: parsed?.breakdown,
        });
      } catch (err) {
        log("mind", `failed to get context breakdown for session "${s.name}":`, err);
        infos.push({
          name: s.name,
          contextTokens: s.contextTokens,
          contextWindow: maxContextTokens,
        });
      }
    }
    return { sessions: infos, systemPrompt: systemPromptTokens };
  }

  async function getContextMessages(): Promise<ContextMessages> {
    const skillsDir = resolvePath(options.cwd, ".pi/skills");
    const sessionMessages: ContextMessages["sessions"] = [];
    for (const s of sessions.values()) {
      try {
        const jsonlPath = findPiSessionFile(piSessionsDir, s.name);
        const result = jsonlPath
          ? await processPiSession(jsonlPath, systemPromptTokens, claudeMdTokens, skillDescTokens)
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

  return { resolve, getContextInfo, getContextMessages };
}
