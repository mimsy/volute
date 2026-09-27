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
import { daemonEmit, daemonNotice, daemonRecollection } from "./lib/daemon-client.js";
import { dispatchPrompt } from "./lib/dispatch.js";
import { createEventHandler, emit } from "./lib/event-handler.js";
import { runHooks } from "./lib/hook-loader.js";
import {
  createIdentityNotice,
  IDENTITY_PENDING_PHRASE,
  type IdentitySnapshot,
  sameIdentity,
  snapshotIdentityFiles,
} from "./lib/identity-watch.js";
import { log } from "./lib/logger.js";
import { MECHANICS_DOC, STALE_DOC_LINE } from "./lib/mechanics-doc.js";
import { archiveLostPiTranscript, rotatePiSession, seedPiSession } from "./lib/pi-session-seed.js";
import { postToolUseInput } from "./lib/post-tool-use-input.js";
import { createReplyInstructionsExtension } from "./lib/reply-instructions-extension.js";
import { resolveModel } from "./lib/resolve-model.js";
import { buildSeededNote, type SeedCause } from "./lib/seed-note.js";
import { createSessionBashTool } from "./lib/session-bash.js";
import {
  capitalize,
  clearCommitted,
  isCommitted,
  markCommitted,
  threadRef,
} from "./lib/session-marker.js";
import { recallTokenBudget } from "./lib/session-seed.js";
import { getStartupContext, type StartupSource, type SubagentConfig } from "./lib/startup.js";
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
  /**
   * The system prompt this session runs on, rebuilt from disk when the session is created
   * and when it rotates or starts over — so an identity edit loads at the next boundary
   * without restarting the mind or rewriting a live session's prompt (and cache) — with
   * the notice that tells the mind, once, when an identity file differs from what it was
   * built from.
   */
  prompt?: SessionPrompt;
  /**
   * The prompt the current run was actually sent (captured as it starts). The identity
   * notice checks against this one, so a rebuild that lands while a run is already under
   * way can't make a pre-edit prompt look current.
   */
  runPrompt?: SessionPrompt;
  /**
   * The transcript this session started on carries an identity notice that called an
   * edit pending — true no longer, since the prompt was rebuilt at that boundary. Says so
   * once, on the next turn.
   */
  identityLoadedNotePending?: boolean;
  /** Why the session failed to start, for the messages that were waiting on it. */
  initError?: unknown;
  /** Prompts handed to pi and not yet resolved — an ephemeral session is evicted at 0. */
  inFlight: number;
  /** Subagent usage for the current turn — see EventSession.subagentUsage. */
  subagentUsage: UsageByModel[];
  /**
   * One-shot injections offered to the run in flight — cleared (as delivered) only once
   * that run settles, so a turn that never ran re-offers them rather than losing them.
   */
  offered: Set<"seeded" | "startup" | "rotation" | "identity-loaded">;
  /**
   * The seam this session's startup context names — set when the session starts, rotates
   * or starts over (as claude's SessionStart runs per stream). The hook itself runs on the
   * first turn after it, so what it reports (the time, the spend line) is current then.
   */
  startupSource?: StartupSource;
  /** True once the current startup context has reached a settled run. */
  startupContextDelivered?: boolean;
  /**
   * True when this session was seeded from the previous session's transcript. Injects
   * the honest-boundary note until a run it was offered to settles (matching claude).
   */
  seeded?: boolean;
  /** When the seeded-from session was archived (epoch ms), for the gap note; null if unknown. */
  seededArchivedAt?: number | null;
  /** Why the tail is seeded — picks the boundary note's wording. Last cause wins. */
  seededCause?: SeedCause;
  /** The latest seed (restore or rotation) carried recollection — the note says so. */
  seededRecollection?: boolean;
  /**
   * Open from a run's agent_end — when the daemon hears `done` and may send the next
   * message — until the run has settled and any rotation (which may await the daemon's
   * recollection) is done. New messages wait on it before dispatching, rather than
   * joining a run that's winding down or piling into pi's settle-deferral queue (which
   * runs them inside the settling prompt's own call, where one message's failure lands on
   * another's turn and cuts off the rest).
   */
  settle?: { promise: Promise<void>; open: boolean; release(): void };
  /**
   * Open while a fresh prompt is on its way into a run (pi's pre-run awaits: hooks, image
   * normalization) and closed at agent_start. The next message waits for it, so at most
   * one prompt is ever between pi's checks and its run: a second one can't slip into a
   * run of its own while the first run's settle is rotating the session under it.
   */
  freshPrompt?: Promise<void>;
  /** Closes `freshPrompt` when the run it was waiting for starts. */
  onRunStart?: () => void;
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

/** A built system prompt and the identity files it was built from. */
type PromptBuild = { prompt: string; baseline: IdentitySnapshot; tokens?: number };
type SessionPrompt = { build: PromptBuild; notice: { check(): string | null } };

/** Told on the first turn of a session whose carried transcript holds an identity notice. */
const IDENTITY_LOADED_NOTE =
  "Your system prompt was rebuilt from your identity files as they are now when this " +
  "session started, so an identity edit that an earlier note above calls pending is " +
  "now loaded.";

export async function createMind(options: {
  /** Builds the system prompt from disk; throws when it can't (at startup, that's fatal). */
  loadSystemPrompt: () => string;
  cwd: string;
  mindDir: string;
  /** Directory holding pi session subdirs (`<sessionsDir>/<name>/*.jsonl`). */
  sessionsDir: string;
  model?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  maxContextTokens?: number;
  /**
   * Estimated-token budget for a seed's verbatim tail. 0 disables seeding. Omitted, it
   * follows what arrived (see SeedBudget.seedTokens).
   */
  seedTokens?: number;
  /** Seed the mind's recollection ahead of the verbatim tail at every seam. Default true. */
  recollection?: boolean;
  subagents?: Record<string, SubagentConfig>;
  /** The model runtime to use instead of creating one — lets tests supply a fake provider. */
  modelRuntime?: ModelRuntime;
}): Promise<{
  resolve: HandlerResolver;
  getContextInfo: () => Promise<ContextInfo>;
  getContextMessages: () => Promise<ContextMessages>;
}> {
  const sessions = new Map<string, PiSession>();
  /**
   * Build the prompt and record the identity files it was built from. The files are read
   * on both sides of the build and it's retried if they moved, so the baseline is the
   * bytes the prompt holds; if they keep moving, the earlier read is kept — erring toward
   * a notice the mind didn't need rather than a change it's never told about.
   */
  function loadPromptBuild(): PromptBuild {
    let before = snapshotIdentityFiles(options.cwd);
    for (let attempt = 0; ; attempt++) {
      const prompt = options.loadSystemPrompt();
      const after = snapshotIdentityFiles(options.cwd);
      if (sameIdentity(before, after) || attempt === 2) return { prompt, baseline: before };
      before = after;
    }
  }
  /** Loaded at startup, where a failure is fatal; afterwards the last one that loaded. */
  let lastGoodBuild = loadPromptBuild();
  /** The startup build is fresh: the first session takes it rather than loading again. */
  let startupBuildUnused = true;
  function promptTokens(build: PromptBuild): number {
    build.tokens ??= countSystemPromptTokens(build.prompt);
    return build.tokens;
  }
  const maxContextTokens = options.maxContextTokens;
  const seedTokens = options.seedTokens;
  const recollect = options.recollection !== false ? daemonRecollection : undefined;
  const recallTokens = recallTokenBudget(maxContextTokens);

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

  /**
   * A session boundary: rebuild the system prompt from disk and start the identity-edit
   * baseline at the files it was built from. If the rebuild fails, the last good prompt
   * is kept *with its own baseline*, so the mind is told its edit didn't load rather than
   * shown a notice-free session running an older prompt. pi has no idle reaper, so the
   * boundaries the notice names are rotation, sleep and restart. Returns whether it rebuilt.
   */
  function rebuildSystemPrompt(session: PiSession): boolean {
    let rebuilt = true;
    try {
      if (!startupBuildUnused) lastGoodBuild = loadPromptBuild();
      startupBuildUnused = false;
    } catch (err) {
      rebuilt = false;
      log("mind", "failed to rebuild system prompt, keeping the last good one:", err);
    }
    session.prompt = {
      build: lastGoodBuild,
      notice: createIdentityNotice(options.cwd, {
        sessionIdleMinutes: 0,
        mechanicsDoc: { file: MECHANICS_DOC, staleLine: STALE_DOC_LINE },
        baseline: lastGoodBuild.baseline,
      }),
    };
    return rebuilt;
  }

  /** The transcript a boundary handed this session still holds an identity notice. */
  function carriesIdentityNotice(path: string | undefined): boolean {
    try {
      return !!path && readFileSync(path, "utf-8").includes(IDENTITY_PENDING_PHRASE);
    } catch {
      return false;
    }
  }

  /** A session just started, rotated or reset: its next turn is oriented afresh. */
  function refreshStartupContext(session: PiSession, source: StartupSource) {
    session.startupContextDelivered = false;
    session.startupSource = source;
  }

  /**
   * Run the startup-context hook for this turn. getStartupContext reports a hook's own
   * failure; anything that escapes it is logged here, and the turn runs without it.
   */
  async function loadStartupContext(session: PiSession): Promise<string | null> {
    try {
      return await getStartupContext({
        session: session.name,
        source: session.startupSource ?? "startup",
        mindDir: options.mindDir,
      });
    } catch (err) {
      log("mind", `session "${session.name}": startup context failed:`, err);
      return null;
    }
  }

  // --- Dynamic hook extension ---

  const hooksDir = resolvePath(options.cwd, ".local/hooks");

  function createDynamicHookExtension(session: PiSession): ExtensionFactory {
    const pendingToolArgs = new Map<string, Record<string, unknown>>();

    return (pi) => {
      pi.on("tool_execution_start", (event) => {
        pendingToolArgs.set(event.toolCallId, event.args);
      });

      pi.on("before_agent_start", async (event) => {
        const parts: string[] = [];

        // The one-shot injections below (seeded note, startup context, rotation note) are
        // not consumed here: this is only dispatch, and a turn that never runs would lose
        // them forever and invisibly. Each is recorded as offered and cleared once the
        // run settles (see onSettled); worst case one is offered twice (cosmetic) rather
        // than never.

        // On a seeded session, lead with the honest-boundary note so the restored
        // transcript above isn't mistaken for a continuously-lived conversation.
        if (session.seeded) {
          session.offered.add("seeded");
          const note = buildSeededNote({
            cause: "restored",
            archivedAtMs: session.seededArchivedAt ?? null,
            recollection: session.seededRecollection,
          });
          emit(session, {
            type: "context",
            content: note,
            metadata: { source: "seeded-session" },
          });
          parts.push(note);
        }

        // Inject startup context on the first turn of each session
        if (!session.startupContextDelivered) {
          session.offered.add("startup");
          const startupContext = await loadStartupContext(session);
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
        // which only fires on a freshly created agent session).
        if (session.rotationNotePending) {
          session.offered.add("rotation");
          const note = buildSeededNote({
            cause: "rotation",
            recollection: session.seededRecollection,
          });
          emit(session, {
            type: "context",
            content: note,
            metadata: { source: "seeded-session" },
          });
          parts.push(note);
        }

        if (session.identityLoadedNotePending) {
          session.offered.add("identity-loaded");
          emit(session, {
            type: "context",
            content: IDENTITY_LOADED_NOTE,
            metadata: { source: "identity-notice" },
          });
          parts.push(IDENTITY_LOADED_NOTE);
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
        // As on claude, post-tool-use hooks follow a call that succeeded.
        if (event.isError) return;
        try {
          const result = await runHooks(
            hooksDir,
            "post-tool-use",
            postToolUseInput({
              session: session.name,
              sessionId: session.agentSession?.sessionManager.getSessionId(),
              transcriptPath: session.agentSession?.sessionManager.getSessionFile(),
              cwd: options.cwd,
              toolName: event.toolName,
              toolCallId: event.toolCallId,
              toolInput,
              toolResponse: event.result,
            }),
          );
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
      offered: new Set(),
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
    const rebuilt = rebuildSystemPrompt(session);
    const dir = resolvePath(options.sessionsDir, session.name);

    // Fresh persistent session — seed it from the previous session's archived
    // transcript so the mind experiences the conversation continuing rather than
    // waking into an empty context. seedPiSession no-ops when a live session
    // already exists (continueRecent will resume that instead). Ephemeral
    // `new-*` sessions are one-offs — they never seed at start. Awaited here because
    // recollection comes from the daemon; messages wait on session.ready meanwhile.
    const seeded = isEphemeral
      ? null
      : await seedPiSession({
          cwd: options.cwd,
          piSessionsDir: options.sessionsDir,
          name: session.name,
          seedTokens,
          recallTokens,
          recollect,
          model: `${model.provider}/${model.id}`,
        });

    // Whether this thread is known to hold real conversation — see session-marker.ts.
    // Sticky; cleared only where the thread genuinely starts over.
    let committed = !isEphemeral && isCommitted(dir);

    // Every session (ephemeral too) is file-backed under its own name-scoped dir,
    // so rotation applies uniformly at the context limit. Ephemerality is only that
    // `new-*` sessions never seed at start and never archive on rotation — not a
    // different backing store. Their unique `new-<ts>-<rand>` names mean the dir is
    // always fresh, so continueRecent starts them empty (no seed to adopt).
    //
    // Opening is the one step whose failure belongs to the transcript: continueRecent
    // reads and parses it, and buildSessionContext is the projection createAgentSession
    // would build from it. So it's the one failure a fresh start gets past. Anything
    // later (resource loading, the model runtime) has nothing to do with the transcript:
    // it fails the turn and leaves the transcript for the next message to resume.
    let sessionManager: SessionManager;
    // A session file already on disk is real conversation: pi writes one only after the
    // first assistant reply, and seeds and rotations write theirs with a tail. Absent,
    // continueRecent started an empty session.
    let resumed = false;
    // If continueRecent adopted our seed file, its header id is the seeded id; if it
    // fell back to a truly fresh session it minted a different id, so the honest-boundary
    // note never lies about a conversation that didn't continue.
    let adoptedSeed = false;
    try {
      sessionManager = SessionManager.continueRecent(options.cwd, dir);
      resumed = existsSync(sessionManager.getSessionFile() ?? "");
      adoptedSeed = !!seeded && sessionManager.getSessionId() === seeded.sessionId;
      if (resumed) sessionManager.buildSessionContext();
    } catch (err) {
      log("mind", `session "${session.name}": transcript can't be resumed, starting fresh:`, err);
      // Throws too when the directory itself is unusable: then nothing was abandoned,
      // and the error fails the turn with the transcript left in place.
      sessionManager = SessionManager.create(options.cwd, dir);
      // A seed just written is the newest transcript, so it's the one that failed. It
      // is the restored conversation even before the thread has a marker (sleep archived
      // that along with the directory), so its loss is real too.
      if (committed || seeded) {
        noticeContextLost(
          session.name,
          `${capitalize(threadRef(session.name))} couldn't be resumed after an error, so it ` +
            "started fresh — the conversation before the reset was lost. `volute mind " +
            "history` has the record of what you were doing.",
        );
      }
      if (!isEphemeral) clearCommitted(dir);
      committed = false;
      resumed = false;
      adoptedSeed = false;
    }

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

    if (seeded && adoptedSeed) {
      session.seeded = true;
      session.seededArchivedAt = seeded.archivedAt;
      session.seededCause = "restored";
      session.seededRecollection = seeded.recallEntries > 0;
      log("mind", `session "${session.name}": seeded from previous transcript`);
    }

    log("mind", `session "${session.name}": ${isEphemeral ? "ephemeral" : "persistent"}`);
    // A seeded thread is a new session carrying a tail; only a transcript resumed as it was
    // continues an existing one.
    refreshStartupContext(session, resumed && !adoptedSeed ? "resume" : "startup");
    // The prompt was rebuilt above; an identity notice in what this session carries over
    // (resumed or seeded) promised an edit that is now loaded.
    session.identityLoadedNotePending =
      rebuilt && resumed && carriesIdentityNotice(sessionManager.getSessionFile());

    // Compaction is rotation (not SDK /compact), and it's silent: crossing the
    // threshold (onContextTokens) or a native PreCompact just sets rotatePending; the
    // session rotates in place once the run that crossed it has settled — no warning,
    // no wrap-up turn. The auto summarizer's turn summaries are the record of collapsed
    // turns, and the one-line rotation note marks the boundary on the next turn. Past
    // the runaway cap nothing schedules a rotation, so the SDK's native compaction (let
    // through on its second pass, inside the run) is the backstop.
    let compactBlocked = false;
    let rotatePending = false;

    /**
     * Rotate the session in place onto a synthetic session holding the verbatim recent
     * tail (the seedTokens-budget tail), then switch the running SessionManager to it.
     * Returns false if rotation can't proceed (session not ready, or the file build failed) so
     * the caller can fall back to a fresh session. The setSessionFile + refreshContext
     * pair is the load-bearing adoption step: the SessionManager is the canonical source
     * of provider context, and refreshContext re-projects the agent's public transcript
     * from it (assigning state.messages directly no longer changes what the mind sees).
     */
    async function rotateInPlace(): Promise<boolean> {
      const as = session.agentSession;
      const sourcePath = as?.sessionManager.getSessionFile();
      if (!as || !sourcePath) return false; // not ready — fall back to fresh
      // Recollection comes from the daemon, so this awaits. The session stays quiet across
      // it: this runs inside pi's agent_settled emission, which pi awaits, deferring any
      // prompt() until it returns — nothing is appended to the transcript read here.
      const rotated = await rotatePiSession({
        cwd: options.cwd,
        sessionsDir: options.sessionsDir,
        name: session.name,
        sourcePath,
        seedTokens,
        recallTokens,
        recollect,
        model: `${model.provider}/${model.id}`,
      });
      if (!rotated) return false;
      as.sessionManager.setSessionFile(rotated.path);
      as.refreshContext();
      session.rotationNotePending = true;
      session.seededCause = "rotation";
      session.seededRecollection = rotated.recallEntries > 0;
      refreshStartupContext(session, "compact");
      session.identityLoadedNotePending =
        rebuildSystemPrompt(session) && carriesIdentityNotice(rotated.path);
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
        // Move the old transcript out of the live dir first: left there, a restart before
        // the fresh session's first reply is written would resume it (continueRecent picks
        // the newest file there) — bringing back the context the mind was just told it lost.
        // Nor into the archive a wake seeds from, for the same reason.
        const oldPath = as.sessionManager.getSessionFile();
        if (!isEphemeral && oldPath && existsSync(oldPath)) {
          try {
            archiveLostPiTranscript(options.sessionsDir, session.name, oldPath);
          } catch (err) {
            log("mind", `session "${session.name}": archiving the lost transcript failed:`, err);
          }
        }
        as.sessionManager.newSession();
        as.refreshContext();
      }
      refreshStartupContext(session, "clear");
      rebuildSystemPrompt(session);
      session.identityLoadedNotePending = false;
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
     * A run has fully settled: pi has finished any retry, native-compaction check and
     * queued continuation, and nothing is streaming. This — not agent_end, which the
     * daemon's `done` follows, and after which a queued follow-up can still be streaming
     * in the same run — is the only point where swapping the session file can't land
     * under a live turn. pi awaits it inside its settle emission, during which a new
     * prompt() is deferred until after it, so nothing can start mid-swap — including
     * while rotation awaits the daemon's recollection. Our own messages don't lean on
     * that deferral: they wait on `session.settle`, held from agent_end, and on
     * `session.freshPrompt`, so none is in pi's pre-run while a settle rotates.
     */
    async function onSettled() {
      holdForSettle(session);
      try {
        const as = session.agentSession;
        // The run resolved, so the one-shot injections offered to it had their chance to
        // land. Cleared before any rotation below arms the next rotation note.
        if (session.offered.has("seeded")) session.seeded = false;
        if (session.offered.has("startup")) session.startupContextDelivered = true;
        if (session.offered.has("rotation")) session.rotationNotePending = false;
        if (session.offered.has("identity-loaded")) session.identityLoadedNotePending = false;
        session.offered.clear();
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
        if (!(await rotateInPlace())) {
          // Rotation couldn't proceed — fresh session, not a silent native compaction.
          freshFallback();
        }
      } catch (err) {
        log("mind", `session "${session.name}": settle error, resetting rotation state:`, err);
        rotatePending = false;
      } finally {
        session.settle?.release();
      }
    }

    const turnBoundaryExtension: ExtensionFactory = (pi) => {
      // Every run is sent this session's own prompt. pi resets a run's prompt options when
      // it settles, and diffs the prompt against the one its transcript last carried, so a
      // rebuilt prompt reaches the model as a patch on the next run — and a prompt that
      // hasn't changed sends nothing.
      pi.on("before_agent_start", (event) => {
        session.runPrompt = session.prompt;
        event.systemPromptOptions.customPrompt = session.runPrompt?.build.prompt;
      });
      // After any tool — an identity edit can come through edit, write or bash — tell the
      // mind, once per prompt build, that the edit loads at the next boundary. Appended to
      // the tool's own result, where claude's PostToolUse context lands.
      pi.on("tool_result", (event) => {
        const note = session.runPrompt?.notice.check();
        if (!note) return;
        emit(session, { type: "context", content: note, metadata: { source: "identity-notice" } });
        return { content: [...event.content, { type: "text" as const, text: note }] };
      });
      pi.on("agent_start", () => {
        session.onRunStart?.();
        session.onRunStart = undefined;
      });
      pi.on("agent_end", () => holdForSettle(session));
      pi.on("agent_settled", onSettled);
      pi.on("session_before_compact", () => {
        // The SDK's native auto-compaction wants to fire. Converge it onto rotation:
        // the first pass marks the session for rotation once the run settles (unless the
        // threshold path already did, or the runaway cap is hit) and blocks the native
        // compaction; the second pass allows native compaction as the emergency
        // backstop (only reachable if rotation never brought context under control).
        if (!compactBlocked) {
          compactBlocked = true;
          if (!rotatePending && (session.consecutiveRotations ?? 0) < MAX_CONSECUTIVE_ROTATIONS) {
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
        systemPrompt: session.prompt?.build.prompt,
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

    const agentSession = await startAgentSession(sessionManager);

    // Started cleanly: a transcript on disk is real conversation (see `resumed`). Marked
    // only now, so a thread that can't start isn't marked on the strength of a transcript
    // it never got to use.
    if (!committed && !isEphemeral && existsSync(sessionManager.getSessionFile() ?? "")) {
      markCommitted(dir);
      committed = true;
    }

    session.agentSession = agentSession;

    session.unsubscribe = agentSession.subscribe(
      createEventHandler(session, {
        cwd: options.cwd,
        broadcast: (event) => broadcast(session, event),
        mainModel: `${model.provider}:${model.id}`,
        onContextTokens: (tokens: number) => {
          session.contextTokens = tokens;
          if (
            maxContextTokens &&
            tokens >= maxContextTokens &&
            !rotatePending &&
            (session.consecutiveRotations ?? 0) < MAX_CONSECUTIVE_ROTATIONS
          ) {
            log(
              "mind",
              `session "${session.name}": ${tokens} tokens >= ${maxContextTokens} — rotation pending at turn end`,
            );
            rotatePending = true;
          }
        },
      }),
    );

    log("mind", `session "${session.name}": ready`);
  }

  /** Open the session's settle hold, unless one is already open. See PiSession.settle. */
  function holdForSettle(session: PiSession) {
    if (session.settle?.open) return;
    let resolve!: () => void;
    const settle = {
      promise: new Promise<void>((r) => {
        resolve = r;
      }),
      open: true,
      release() {
        settle.open = false;
        // Released on the next macrotask, not now: pi is still inside its settle emission
        // until the handler's promise has resolved through it, and a prompt() made before
        // then would be deferred into the queue we're keeping messages out of. Cleared
        // only if no later run has opened a hold of its own meanwhile.
        setImmediate(() => {
          if (session.settle === settle) session.settle = undefined;
          resolve();
        });
      },
    };
    session.settle = settle;
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
    // An event that names its own message (a failed dispatch's done) keeps it: re-tagged
    // with whichever turn is current, its caller's listener would never see it.
    const tagged =
      event.messageId == null && session.currentMessageId != null
        ? { ...event, messageId: session.currentMessageId }
        : event;
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
          for (;;) {
            const wait = session.settle?.promise ?? session.freshPrompt;
            if (!wait) break;
            await wait;
          }
          const as = session.agentSession;
          if (!as) {
            // The session failed to start (and has been evicted). Fail this turn loudly
            // through the catch below rather than dropping the message with only a local
            // done: the daemon would never hear the turn ended.
            throw session.initError ?? new Error("session failed to start");
          }
          let releaseFresh: (() => void) | undefined;
          if (!as.isStreaming) {
            const gate = new Promise<void>((r) => {
              releaseFresh = () => {
                if (session.freshPrompt === gate) session.freshPrompt = undefined;
                r();
              };
            });
            session.freshPrompt = gate;
            session.onRunStart = releaseFresh;
          }
          try {
            // This await is load-bearing: without it a prompt rejection (burst race,
            // auth failure, ...) floats as an unhandled rejection and crashes the
            // mind server instead of landing in the .catch below (issue #565).
            await dispatchPrompt(as, text, opts, meta.interrupt === true, () =>
              interruptSession(sessionName),
            );
          } finally {
            releaseFresh?.();
          }
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
  const claudeMdTokens = countSdkInstructionTokens(options.cwd);
  const skillDescTokens = countSkillDescriptionTokens([resolvePath(options.cwd, ".pi/skills")]);

  async function getContextInfo(): Promise<ContextInfo> {
    const infos: SessionContextInfo[] = [];
    for (const s of sessions.values()) {
      try {
        const jsonlPath = findPiSessionFile(piSessionsDir, s.name);
        // Each thread runs its own prompt (built at its last boundary). Cache the computed
        // breakdown by file identity and that prompt: polls between turns are free.
        const tokens = promptTokens(s.prompt?.build ?? lastGoodBuild);
        const parsed = jsonlPath
          ? await getCachedContextInfo(
              jsonlPath,
              async () =>
                (await processPiSession(jsonlPath, tokens, claudeMdTokens, skillDescTokens)).parsed,
              String(tokens),
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
    return { sessions: infos, systemPrompt: promptTokens(lastGoodBuild) };
  }

  async function getContextMessages(): Promise<ContextMessages> {
    const skillsDir = resolvePath(options.cwd, ".pi/skills");
    const sessionMessages: ContextMessages["sessions"] = [];
    for (const s of sessions.values()) {
      try {
        const jsonlPath = findPiSessionFile(piSessionsDir, s.name);
        const result = jsonlPath
          ? await processPiSession(
              jsonlPath,
              promptTokens(s.prompt?.build ?? lastGoodBuild),
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
        // One preamble for every thread: the newest prompt built. Each thread's own is
        // counted in its breakdown above.
        systemPrompt: lastGoodBuild.prompt,
        sdkInstructions: readSdkInstructions(options.cwd),
        skillDescriptions: readSkillDescriptions([skillsDir]),
      },
      sessions: sessionMessages,
    };
  }

  return { resolve, getContextInfo, getContextMessages };
}
