import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { HookCallback, SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { toSDKContent } from "./lib/content.js";
import {
  countSdkInstructionTokens,
  countSkillDescriptionTokens,
  countSystemPromptTokens,
  findClaudeSessionFile,
  getCachedContextInfo,
  processClaudeSession,
  readSdkInstructions,
  readSkillDescriptions,
} from "./lib/context-breakdown.js";
import { daemonEmit, daemonNotice, daemonRecollection } from "./lib/daemon-client.js";
import { runHooks } from "./lib/hook-loader.js";
import { createAutoCommitHook } from "./lib/hooks/auto-commit.js";
import { createIdentityNoticeHook } from "./lib/hooks/identity-notice.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- used as value
import { createPreCompactHook } from "./lib/hooks/pre-compact.js";
import { createReplyInstructionsHook } from "./lib/hooks/reply-instructions.js";
import { log } from "./lib/logger.js";
import { createMessageChannel } from "./lib/message-channel.js";
import { relockstepMessageIds } from "./lib/recover.js";
import { crossSeam } from "./lib/seam.js";
import { buildSeededNote, type SeedCause } from "./lib/seed-note.js";
import {
  coldResetPossible,
  createActivityClock,
  DEFAULT_COLD_RESET_MINUTES,
  interruptCurrentTurn,
  isSessionReapable,
  reapSessionQuery,
  reapSessionsForShutdown,
  reapTimeoutMs,
  shouldColdReset,
} from "./lib/session-reaper.js";
import {
  DEFAULT_SEED_TOKENS,
  RECALL_TOKEN_CAP,
  rotateSession,
  seedSession,
  TAIL_ONLY_SEED_TOKENS,
} from "./lib/session-seed.js";
import { createSessionStore, lostRealContext } from "./lib/session-store.js";
import type { EffortLevel, SubagentConfig, ThinkingConfig } from "./lib/startup.js";
import { consumeStream, type MessageIdEntry } from "./lib/stream-consumer.js";
import { createBuiltinSubagentModelHook, defaultSubagentModel } from "./lib/subagent-model.js";
import { createSystemPromptSource } from "./lib/system-prompt.js";
import type {
  HandlerMeta,
  HandlerResolver,
  Listener,
  MessageHandler,
  VoluteContentPart,
  VoluteEvent,
} from "./lib/types.js";
import type { ContextInfo, ContextMessages, SessionContextInfo } from "./lib/volute-server.js";

type Session = {
  name: string;
  channel: ReturnType<typeof createMessageChannel>;
  listeners: Set<Listener>;
  messageIds: MessageIdEntry[];
  currentMessageId?: string;
  currentSeq?: number;
  currentQuery?: ReturnType<typeof query>;
  messageChannels: Map<string, { channel: string; sender?: string }>;
  replyInstructionsFired: boolean;
  replyInstructionsMode: "once" | "always" | "never";
  /** The event note is a standing fact about events, so it fires once per session. */
  eventNoteFired: boolean;
  contextTokens: number;
  /** Last inbound message or completed turn — drives idle reaping. */
  lastActivityAt: number;
  /**
   * True when this session was seeded from the previous session's transcript.
   * Injects the honest-boundary note on each prompt until a turn resolves (see
   * the pre-prompt hook and onTurnEnd), so an interrupted first turn re-offers it.
   */
  seeded: boolean;
  /** When the seeded-from session was archived (epoch ms), for the gap note; null if unknown. */
  seededArchivedAt: number | null;
  /** Why the tail is seeded — picks the boundary note's wording. Last cause wins. */
  seededCause: SeedCause;
  /** Whether the seed carried recall entries — the seam note says so only then. */
  seededRecollection: boolean;
  /** Torn down (idle reap or shutdown): a seam in flight must not start a new stream. */
  closed: boolean;
  /**
   * Back-to-back rotations that did NOT bring context under the threshold (reset by
   * any healthy turn). Guards against a runaway loop when the tail alone can't fit —
   * e.g. a system prompt (large MEMORY.md) that already fills most of the window, which
   * rotation can't trim. Past the cap we stop rotating and defer to native compaction.
   */
  consecutiveRotations: number;
  /**
   * True when this session crossed the context threshold (or the SDK tried to
   * auto-compact) and should rotate in place when the current turn ends. Rotation
   * is deliberately silent: no warning, no wrap-up turn — the auto summarizer's
   * turn summaries are the record of collapsed turns, and the one-line
   * ROTATED_SESSION_NOTE marks the boundary on the next turn.
   */
  rotationPending: boolean;
};

/** Stop self-rotating after this many back-to-back rotations that didn't reduce context. */
const MAX_CONSECUTIVE_ROTATIONS = 3;

/**
 * How a notice that can be read from any thread should name the thread it is about.
 *
 * Amnesia notices are recorded mind-level so they can't strand (#768), which means the
 * reader may be somewhere else entirely and "this thread" points at nothing. Ephemeral
 * `new-*` sessions are named after nothing the mind has ever seen, so naming one would
 * be worse than not naming it.
 */
function threadRef(name: string): string {
  return name.startsWith("new-") ? "a one-off session" : `the \`${name}\` thread`;
}

export function createMind(options: {
  /** Builds the system prompt from disk — once now, then again for every new SDK stream. */
  loadSystemPrompt: () => string;
  cwd: string;
  abortController: AbortController;
  model?: string;
  thinking?: ThinkingConfig;
  effort?: EffortLevel;
  sessionsDir: string;
  maxContextTokens?: number;
  subagents?: Record<string, SubagentConfig>;
  /** Idle minutes before a session's SDK subprocess is reaped. 0 disables. Default 30. */
  sessionIdleMinutes?: number;
  /** Estimated-token budget for a seed's verbatim tail. 0 disables seeding. Default 10000. */
  seedTokens?: number;
  /** Idle minutes before a persistent session is archived and re-seeded. 0 disables. Default 55. */
  coldResetMinutes?: number;
  /** Seed the mind's recollection ahead of the verbatim tail at every seam. Default true. */
  recollection?: boolean;
}): {
  resolve: HandlerResolver;
  flushFileChanges: () => Promise<void>;
  getContextInfo: () => Promise<ContextInfo>;
  getContextMessages: () => Promise<ContextMessages>;
  reapAllSessions: () => Promise<void>;
} {
  const autoCommit = createAutoCommitHook(options.cwd);
  const systemPrompt = createSystemPromptSource(options.loadSystemPrompt);
  // Undefined → the seeders size the tail by what arrived (see SeedBudget.seedTokens).
  const seedTokens = options.seedTokens;
  const configuredColdResetMs = (options.coldResetMinutes ?? DEFAULT_COLD_RESET_MINUTES) * 60_000;
  const coldResetMs = coldResetPossible(configuredColdResetMs, seedTokens)
    ? configuredColdResetMs
    : 0;
  // The reaper also retires a live session by the cold-reset threshold (unless reaping
  // is off), so it cold-resets when its next turn arrives. It's also the resume boundary
  // the identity notice names.
  const idleMinutes =
    reapTimeoutMs((options.sessionIdleMinutes ?? 30) * 60_000, coldResetMs) / 60_000;
  const sessionStore = createSessionStore(options.sessionsDir);
  const postToolUseHooks: { matcher: string; hooks: HookCallback[] }[] = [
    { matcher: "Edit|Write", hooks: [autoCommit.hook] },
  ];

  const sessions = new Map<string, Session>();
  const maxContextTokens = options.maxContextTokens;
  const recollection = options.recollection !== false;
  const recollect = recollection ? daemonRecollection : undefined;
  // A quarter of the window at most, so prefix + recollection + tail stays well under
  // the rotation threshold (a prefix too big for that is the consecutive-rotation cap's).
  const recallTokens = Math.min(
    RECALL_TOKEN_CAP,
    maxContextTokens ? Math.floor(maxContextTokens / 4) : RECALL_TOKEN_CAP,
  );
  // The biggest seed a cold reset could produce, plus a margin: a session no larger than
  // this (estimated from its transcript) just resumes — re-seeding it would save nothing.
  const coldResetMinSourceTokens =
    (seedTokens !== undefined
      ? seedTokens + (recollection ? recallTokens : 0)
      : Math.max(DEFAULT_SEED_TOKENS + (recollection ? recallTokens : 0), TAIL_ONLY_SEED_TOKENS)) +
    5000;

  if (maxContextTokens) {
    log("mind", `compaction threshold: ${maxContextTokens} tokens`);
  }

  // --- Subagents (config-driven) ---

  const subagentModel = defaultSubagentModel(options.model);

  type SDKAgent = {
    description: string;
    prompt: string;
    tools: string[];
    model: string;
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
          model: config.model ?? subagentModel,
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

  // --- Skill discovery ---
  // The CLI only discovers skills through its user-scope ~/.claude/skills scan,
  // so the "user" setting source is load-bearing and HOME must be the mind's
  // home dir for the SDK subprocess (isolation modes already set it; pinning it
  // here keeps non-isolated minds from loading the host's ~/.claude). The
  // explicit skills array grants the Skill tool for each installed skill — the
  // SDK silently drops the documented `skills: 'all'` string form.
  const mindHome = resolvePath(options.cwd);
  // CLAUDE_CODE_SUBAGENT_MODEL is the model the SDK's model-less built-in agents
  // (general-purpose) run on — they otherwise inherit the mind's, so it is only set when
  // the default is something else. The built-ins defined as "inherit" (Explore, Plan)
  // never read it, so a PreToolUse hook gives their calls the same default. A mind's own
  // setting of the env var wins, for all of them.
  const defaultBuiltinSubagents =
    subagentModel !== "inherit" && !process.env.CLAUDE_CODE_SUBAGENT_MODEL;
  const sdkEnv = {
    ...process.env,
    HOME: mindHome,
    ...(defaultBuiltinSubagents && { CLAUDE_CODE_SUBAGENT_MODEL: subagentModel }),
  };
  function installedSkills(): string[] | undefined {
    const names = readSkillDescriptions([resolvePath(mindHome, ".claude/skills")]).map(
      (s) => s.name,
    );
    return names.length > 0 ? names : undefined;
  }

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

  const hooksDir = resolvePath(options.cwd, ".local/hooks");

  function wrapHookWithEmit(hook: HookCallback, source: string, session: Session): HookCallback {
    return async (...args) => {
      const result = await hook(...args);
      const syncResult = result as SyncHookJSONOutput;
      const hookOutput = syncResult?.hookSpecificOutput;
      const additionalContext =
        hookOutput && "additionalContext" in hookOutput
          ? (hookOutput.additionalContext as string | undefined)
          : undefined;
      const decision = syncResult?.decision;
      if (additionalContext || decision) {
        const channel = session.currentMessageId
          ? session.messageChannels.get(session.currentMessageId)?.channel
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
        // The SDK's hook input carries only its own `session_id` (a UUID); the volute
        // session name lives in the prompt header. Inject it explicitly so pre-prompt
        // hooks (notices, cross-session activity) can scope their daemon queries — and
        // so the notices drain watermark keys on the same session the "done" event uses.
        const result = await runHooks(hooksDir, event, {
          ...(input as Record<string, unknown>),
          session: session.name,
        });
        if (result.additionalContext || Object.keys(result.metadata).length > 0) {
          const channel = session.currentMessageId
            ? session.messageChannels.get(session.currentMessageId)?.channel
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
        // Only the pre-prompt event injects the dynamic hooks' additionalContext; their
        // post-tool-use output is emitted above but not handed to the SDK.
        if (event !== "pre-prompt") return {};
        let additionalContext = result.additionalContext;
        // On a seeded session, prepend the honest-boundary note. Deliberately NOT
        // cleared here: this hook only hands the note to the SDK at *dispatch*, and
        // the SDK cancels UserPromptSubmit hooks when an interrupt arrives (a
        // `hook_cancelled` transcript entry). That's most likely on the seeded first
        // turn post-wake, when queued inbound messages flood in — exactly when we'd
        // lose the note. Clearing on a mere injection attempt could drop it forever
        // and silently. So the flag is cleared only when a turn actually resolves
        // (onTurnEnd); an interrupted turn re-offers the note next prompt. Worst case
        // it fires twice (cosmetic) instead of zero times (unrecoverable, invisible).
        if (session.seeded) {
          const note = buildSeededNote({
            cause: session.seededCause,
            archivedAtMs: session.seededArchivedAt,
            recollection: session.seededRecollection,
          });
          additionalContext = additionalContext ? `${note}\n\n${additionalContext}` : note;
          // Also surface the note as its own context event (matching codex/pi) so it
          // isn't delivered only in the same low-salience container as routine
          // per-prompt hooks. Once per injection attempt; a duplicate on re-offer is fine.
          const channel = session.currentMessageId
            ? session.messageChannels.get(session.currentMessageId)?.channel
            : undefined;
          daemonEmit({
            type: "context",
            content: note,
            metadata: { source: "seeded-session" },
            session: session.name,
            channel,
            messageId: session.currentMessageId,
          }).catch((err) => log("mind", "seeded-session context emit failed:", err));
        }
        if (!additionalContext) return {};
        return {
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit" as const,
            additionalContext,
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
    const replyInstructions = createReplyInstructionsHook(session.messageChannels, session);

    return query({
      prompt: session.channel.iterable,
      options: {
        // Rebuilt per stream, not per process: an identity edit loads at the next session
        // boundary (reap → resume, rotation, restart) without restarting the mind mid-work.
        systemPrompt: systemPrompt.forNewStream(),
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: ["project", "user"],
        skills: installedSkills(),
        // Per-stream env binds the session slug to this SDK subprocess and every
        // Bash child it spawns — the per-turn X-Volute-Thread source. A process-
        // global (env or file) is last-writer-wins across concurrent sessions.
        env: { ...sdkEnv, VOLUTE_SESSION: session.name },
        cwd: options.cwd,
        abortController: streamAbort,
        model: options.model,
        // Default to visible reasoning: on Opus 4.7+/Sonnet 5 the API omits thinking
        // text unless display is "summarized", so minds' reasoning would otherwise be
        // invisible. A mind can override (e.g. omitted, or enabled+budgetTokens for
        // older models) via `thinking` in config.json.
        thinking: options.thinking ?? { type: "adaptive", display: "summarized" },
        effort: options.effort,
        resume,
        agents,
        hooks: {
          ...(defaultBuiltinSubagents && {
            PreToolUse: [
              {
                matcher: "Agent",
                // home/.claude/agents is both the project and the user agents dir (cwd and
                // HOME are the mind's home).
                hooks: [
                  createBuiltinSubagentModelHook(
                    subagentModel,
                    Object.keys(agents ?? {}),
                    resolvePath(mindHome, ".claude/agents"),
                  ),
                ],
              },
            ],
          }),
          PostToolUse: [
            ...postToolUseHooks,
            {
              // Created with this stream's prompt (above), so its baseline is what the
              // prompt was built from. Any tool: Bash edits identity files too.
              matcher: ".*",
              hooks: [
                wrapHookWithEmit(
                  createIdentityNoticeHook(options.cwd, idleMinutes),
                  "identity-notice",
                  session,
                ),
              ],
            },
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

  function startSession(
    session: Session,
    savedSessionId?: string,
    savedCommitted = false,
    savedLastActivityAt?: number,
    seed?: "restored" | "cold",
  ) {
    (async () => {
      log("mind", `session "${session.name}": stream consumer started`);
      let currentSessionId = savedSessionId;
      // Whether the live pointer is known to reference a transcript holding real
      // conversation — see SessionRecord.committed. Sticky within the session's life;
      // cleared only where we drop the pointer and genuinely start over.
      let committed = savedCommitted;
      // When the session last did anything (turn activity or turn end), carried on every
      // pointer save — the cold reset's clock. See createActivityClock.
      let lastActivityAt = savedLastActivityAt;
      const activity = createActivityClock(
        (at) => {
          if (currentSessionId && !session.name.startsWith("new-"))
            sessionStore.save(session.name, currentSessionId, committed, at);
        },
        (err) => log("mind", `session "${session.name}": failed to record activity:`, err),
      );
      function touchActivity(force: boolean) {
        session.lastActivityAt = Date.now();
        lastActivityAt = session.lastActivityAt;
        activity.touch(lastActivityAt, force);
      }
      let streamAbort = new AbortController();

      /** Mark the session to rotate in place when the current turn ends. */
      function scheduleRotation() {
        session.rotationPending = true;
      }

      // PreCompact backstop: first fire schedules a rotation (unless one is already
      // pending, or the rotation cap is hit) and blocks; second fire allows the SDK's
      // native compaction — the emergency backstop when rotation never intervened
      // (a hung turn, or a system prompt too large for rotation to relieve).
      const preCompact = createPreCompactHook(() => {
        if (!session.rotationPending && session.consecutiveRotations < MAX_CONSECUTIVE_ROTATIONS) {
          log("mind", `session "${session.name}": native compaction — scheduling rotation`);
          scheduleRotation();
        }
      });

      const callbacks = {
        onSessionId: (id: string) => {
          currentSessionId = id;
          // Carry `committed` across the stamp rather than resetting it: if the SDK ever
          // hands a resumed session a new id, that transcript continues the old one and
          // its content is still real (#769). Resetting here would be the worse error —
          // it would silence a genuine loss, where carrying it forward could at worst
          // repeat the false notice once for a session that had already earned the flag.
          if (!session.name.startsWith("new-"))
            sessionStore.save(session.name, id, committed, lastActivityAt);
        },
        onActivity: () => touchActivity(false),
        broadcast: (event: VoluteEvent) => broadcastToSession(session, event),
        // Identity-based ack — stream-consumer.ts calls this once per message the
        // just-finished turn covers (its own driving message, plus any folded in
        // mid-run) so none of them strand in the channel's in-flight set (#764).
        ack: (seq: number) => session.channel.ack(seq),
        onTurnEnd: async () => {
          // A turn has landed in the transcript, so this pointer now references real
          // conversation: if it later goes missing, the loss is genuine and the mind
          // should be told (#769) — the flag is sticky. The (forced) write also records
          // when the turn ended, which the cold reset measures idleness from.
          if (currentSessionId && !session.name.startsWith("new-")) committed = true;
          touchActivity(true);
          // A turn resolved — the seeded note's injection had its chance to land
          // (the pre-prompt hook ran and wasn't cancelled by an interrupt), so stop
          // re-offering it. This is the honest place to clear: a completed turn is
          // the closest-to-arrival signal available without reading the transcript back.
          session.seeded = false;
          await autoCommit.flushFileChanges();
          if (session.rotationPending) {
            // The turn that crossed the threshold is done — abort to rotate in place.
            log(
              "mind",
              `session "${session.name}": turn ended over context limit — aborting to rotate`,
            );
            streamAbort.abort(new CompactionAbort());
          } else {
            // A healthy turn (context under the threshold) — the rotation streak, if
            // any, is over, so re-arm the self-rotation cap.
            session.consecutiveRotations = 0;
          }
        },
        onContextTokens: (tokens: number) => {
          session.contextTokens = tokens;
          if (
            maxContextTokens &&
            tokens >= maxContextTokens &&
            !session.rotationPending &&
            session.consecutiveRotations < MAX_CONSECUTIVE_ROTATIONS
          ) {
            log(
              "mind",
              `session "${session.name}": ${tokens} tokens >= ${maxContextTokens} — rotation pending at turn end`,
            );
            scheduleRotation();
          }
        },
      };

      /** Emit done to both local listeners and the daemon (best-effort with retries). */
      function emitDone() {
        broadcastToSession(session, { type: "done" });
        daemonEmit({ type: "done", session: session.name }).catch((err) => {
          log("mind", `session "${session.name}": failed to emit done to daemon:`, err);
        });
      }

      /**
       * Tell the daemon this turn failed so it can record a notice for the mind's next
       * successful turn. Awaited before emitDone so the daemon flags the session errored
       * (and thus won't mark notices delivered) before the done arrives.
       */
      async function emitError(err: unknown) {
        await daemonEmit({ type: "error", session: session.name, content: String(err) }).catch(
          (e) => log("mind", `session "${session.name}": failed to emit error to daemon:`, e),
        );
      }

      async function runStream(resume?: string) {
        const q = createStream(session, streamAbort, preCompact.hook, resume);
        session.currentQuery = q;
        await consumeStream(q, session, callbacks, { resumed: resume !== undefined });
        if (session.currentMessageId !== undefined) {
          session.messageChannels.delete(session.currentMessageId);
          emitDone();
          session.currentMessageId = undefined;
        }
      }

      try {
        if (seed) {
          // Before the first stream: a restore seed (recollection, then the previous
          // session's verbatim tail) so the mind continues rather than waking empty, or
          // a cold reset — idle past the prompt cache's life, the next turn would rewrite
          // the whole context anyway, so rebuild it compactly (#1124). Awaited here, not
          // in getOrCreateSession, because recollection comes from the daemon; inbound
          // messages queue in the channel meanwhile.
          const seam = await crossSeam({
            seed,
            liveSessionId: currentSessionId,
            lastActivityAt: savedLastActivityAt,
            restore: () =>
              seedSession({
                cwd: options.cwd,
                sessionsDir: options.sessionsDir,
                name: session.name,
                seedTokens,
                recallTokens,
                recollect,
              }),
            coldReset: (live) =>
              rotateSession({
                cwd: options.cwd,
                sessionsDir: options.sessionsDir,
                name: session.name,
                oldSessionId: live,
                seedTokens,
                recallTokens,
                recollect,
                minSourceTokens: coldResetMinSourceTokens,
              }),
            // The seeded transcript carries the previous session's tail — real content
            // from the first stamp, so losing it later is a genuine loss (#769).
            save: (id) => sessionStore.save(session.name, id, true),
            isClosed: () => session.closed,
          });
          if (seam.kind === "closed") {
            log("mind", `session "${session.name}": closed while seeding — not starting`);
            return;
          }
          if (seam.kind === "seeded") {
            committed = true;
            currentSessionId = seam.sessionId;
            lastActivityAt = undefined;
            session.seeded = true;
            session.seededArchivedAt = seam.gapFrom;
            session.seededCause = seam.cause;
            session.seededRecollection = seam.recalled;
            log("mind", `session "${session.name}": seeded (${seam.cause}) → ${seam.sessionId}`);
          } else if (seed === "cold") {
            log("mind", `session "${session.name}": no cold reset, resuming ${currentSessionId}`);
          } else {
            log("mind", `session "${session.name}": starting fresh`);
          }
        }
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
              // Stream was aborted to rotate: replace the session with a synthetic one
              // holding recollection and the verbatim recent tail, then resume it. The
              // aborted query is dead; drop it before awaiting recollection so an
              // interrupt arriving meanwhile doesn't reach into it.
              session.currentQuery = undefined;
              const rotated = await rotateSession({
                cwd: options.cwd,
                sessionsDir: options.sessionsDir,
                name: session.name,
                oldSessionId: currentSessionId,
                seedTokens,
                recallTokens,
                recollect,
              });
              session.rotationPending = false;
              // Torn down (shutdown or reap) during the fetch: start nothing new.
              if (session.closed) break;
              const rotatedId = rotated?.sessionId;
              if (!rotatedId) {
                // Rotation couldn't proceed — fall back to a fresh session (no seed).
                // Unlike a successful rotation (boundary note, verbatim tail, archived
                // transcript), this genuinely loses the live context — say so (#367).
                log("mind", `session "${session.name}": rotation failed, starting fresh`);
                // Mind-level (no `thread`): a thread-scoped notice waits for a turn on
                // that exact thread, which under the stock routes.json may be hours away
                // or never — the mind stays silently amnesiac meanwhile (#768). So the
                // text names the thread it is about, since it can be read anywhere.
                daemonNotice({
                  kind: "context_lost",
                  message:
                    `Session rotation failed at the context limit and ${threadRef(session.name)} ` +
                    "was reset — the conversation before the reset was lost. Your turn " +
                    "summaries survive in `volute mind history` — that's where you left off.",
                }).catch((err) =>
                  log("mind", `session "${session.name}": failed to record notice:`, err),
                );
                sessionStore.delete(session.name);
                currentSessionId = undefined;
                committed = false;
                session.seeded = false;
                streamAbort = new AbortController();
                session.channel = createMessageChannel();
                break;
              }
              // Point the live pointer at the rotated session and arm the boundary
              // note (rotation cause — no gap). Ephemeral `new-*` keep no pointer.
              // The rotated transcript is written with the verbatim recent tail, so the
              // new pointer references real content from the moment it is stamped.
              committed = true;
              if (!session.name.startsWith("new-"))
                sessionStore.save(session.name, rotatedId, true, lastActivityAt);
              currentSessionId = rotatedId;
              session.seeded = true;
              session.seededCause = "rotation";
              session.seededArchivedAt = null;
              session.seededRecollection = (rotated?.recallEntries ?? 0) > 0;
              // Count this rotation; a healthy turn resets it. If back-to-back rotations
              // don't reduce context (system prompt too large to fit the tail under the
              // threshold), the cap stops the loop and defers to native compaction.
              session.consecutiveRotations++;
              if (session.consecutiveRotations >= MAX_CONSECUTIVE_ROTATIONS) {
                log(
                  "mind",
                  `session "${session.name}": ${session.consecutiveRotations} rotations without relief — deferring further compaction to the SDK (system prompt likely too large)`,
                );
              }
              // Re-arm the PreCompact backstop so a future auto-compact blocks + rotates
              // again rather than falling straight through to native compaction.
              preCompact.reset();
              streamAbort = new AbortController();
              // Recover input the aborted stream had already pulled but not finished
              // (anything that arrived mid-turn) so nothing is dropped when the killed
              // subprocess takes its buffer with it.
              const pending = session.channel.recover();
              const oldMessageIds = session.messageIds;
              session.channel = createMessageChannel();
              // Starts from [] — nothing can race into this fresh channel/messageIds
              // before the next line runs (single-threaded, no await in between).
              session.messageIds = relockstepMessageIds(
                pending,
                oldMessageIds,
                session.channel.push,
                [],
              );
              continue; // restart the stream loop on the rotated session
            }
            throw err; // rethrow non-compaction errors
          }
        }
      } catch (err) {
        session.messageChannels.clear();
        if (currentSessionId) {
          log("mind", `session "${session.name}": resume failed, starting fresh:`, err);
          // Mind-level (no `thread`) so it reaches the next turn on any thread (#768).
          daemonNotice({
            kind: "context_lost",
            message:
              `${threadRef(session.name)} couldn't be resumed after an error, so it started ` +
              "fresh — the conversation before the reset was lost. `volute mind history` " +
              "has the record of what you were doing.",
          }).catch((e) => log("mind", `session "${session.name}": failed to record notice:`, e));
          sessionStore.delete(session.name);
          currentSessionId = undefined;
          committed = false;
          // We fell back to a truly empty session — don't tell the mind its
          // conversation continued when the seeded transcript failed to resume,
          // and don't let a half-entered rotation leak into the fresh session.
          session.seeded = false;
          session.rotationPending = false;
          streamAbort = new AbortController();
          session.channel = createMessageChannel();
          try {
            await runStream();
          } catch (retryErr) {
            log("mind", `session "${session.name}": stream consumer error:`, retryErr);
            await emitError(retryErr);
            emitDone();
          }
        } else {
          log("mind", `session "${session.name}": stream consumer error:`, err);
          await emitError(err);
          emitDone();
        }
      } finally {
        // The stream consumer has ended (subprocess exit, error, or fresh-start
        // abandonment) — drop the session so the sessions map doesn't retain dead
        // entries. Matters most for ephemeral $new sessions once the idle reaper
        // (#458) kills their subprocess, but also for any named session that ends.
        // Only this session — a fresh one may already hold the name.
        if (sessions.get(session.name) === session) sessions.delete(session.name);
        log("mind", `session "${session.name}": stream consumer ended`);
      }
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
      replyInstructionsFired: false,
      replyInstructionsMode: "once",
      eventNoteFired: false,
      contextTokens: 0,
      lastActivityAt: Date.now(),
      seeded: false,
      seededArchivedAt: null,
      seededCause: "restored",
      seededRecollection: false,
      closed: false,
      consecutiveRotations: 0,
      rotationPending: false,
    };
    sessions.set(name, session);

    const isEphemeral = name.startsWith("new-");
    const stored = isEphemeral ? undefined : sessionStore.load(name);
    let savedSessionId = stored?.sessionId;
    let committed = stored?.committed ?? false;
    // Validate that the SDK session file still exists — orphaned references
    // cause the SDK to throw and can crash the process with EPIPE.
    if (savedSessionId && !findClaudeSessionFile(options.cwd, savedSessionId)) {
      log("mind", `session "${name}": stored session ${savedSessionId} not found, starting fresh`);
      sessionStore.delete(name);
      savedSessionId = undefined;
      if (lostRealContext(stored)) {
        // Mind-level (no `thread`) so whichever thread next runs a turn drains it,
        // rather than waiting on a turn in this one that may never come (#768); the
        // text names the thread because it can be read anywhere. Worded so it stays
        // true whether or not transcript seeding (below) partially restores context:
        // the live session is gone either way.
        daemonNotice({
          kind: "context_lost",
          message:
            `The previous session for ${threadRef(name)} couldn't be restored (session ` +
            "file missing), so it was reset. `volute mind history` has the record of " +
            "what you were doing.",
        }).catch((err) => log("mind", `session "${name}": failed to record notice:`, err));
      } else {
        // The pointer was stamped when the SDK handed out a session id but no turn ever
        // landed in it, so there is nothing behind it to have lost. Saying "you lost
        // context" here would be a lie on an ordinary restart (#769).
        log("mind", `session "${name}": pointer never carried a turn — nothing was lost`);
      }
      committed = false;
    }
    let seed: "restored" | "cold" | undefined;
    if (savedSessionId) {
      // Idle past the cold-reset threshold (and a seed can be built): startSession
      // re-seeds it before its first turn, or resumes it as is if seeding fails.
      if (shouldColdReset(name, stored, Date.now(), coldResetMs, seedTokens)) {
        log("mind", `session "${name}": idle past ${coldResetMs / 60_000} min — cold reset`);
        seed = "cold";
      } else {
        log("mind", `session "${name}": resuming ${savedSessionId}`);
      }
    } else if (!isEphemeral) {
      // Seeded in startSession. Ephemeral `new-*` sessions never seed.
      seed = "restored";
    } else {
      log("mind", `session "${name}": starting fresh`);
    }

    startSession(
      session,
      savedSessionId,
      committed,
      savedSessionId ? stored?.lastActivityAt : undefined,
      seed,
    );
    return session;
  }

  // --- Idle session reaping ---
  // Each session holds a resident SDK subprocess (~250MB) for its whole life.
  // After the idle timeout, shut the subprocess down while keeping the session
  // resumable: the session id is persisted, so the next inbound message
  // transparently re-creates the session via getOrCreateSession's resume path.
  const idleTimeoutMs = idleMinutes * 60_000;

  async function reapSession(session: Session) {
    log("mind", `session "${session.name}": idle — reaping SDK subprocess (resumable)`);
    // Delete first so a racing inbound message spins up a fresh resumed session
    // instead of reusing the one we're tearing down.
    sessions.delete(session.name);
    session.closed = true;
    // End the input iterable so the stream consumer unwinds (its finally block
    // also deletes from the map, now a no-op), then await the SDK's graceful
    // shutdown via query.return() — unlike the fire-and-forget close(), this
    // awaits the CLI subprocess's exit so the child is reaped instead of left
    // as a <defunct> zombie.
    session.channel.close();
    await reapSessionQuery(session.currentQuery, (err) =>
      log("mind", `session "${session.name}": error reaping SDK subprocess:`, err),
    );
    // Nothing should have raced in (isSessionReapable checked isEmpty), but if it
    // did, re-dispatch into a fresh session so no input is dropped. Same marker
    // treatment as the rotation path (#764) — see relockstepMessageIds above.
    // getOrCreateSession() can return a session an inbound message already raced
    // into during the reapSessionQuery() await above (it pushed its own entry into
    // fresh.messageIds via the normal handler path) — relockstepMessageIds appends
    // onto fresh.messageIds rather than replacing it, so that entry survives.
    const pending = session.channel.recover();
    if (pending.length > 0) {
      const fresh = getOrCreateSession(session.name);
      relockstepMessageIds(pending, session.messageIds, fresh.channel.push, fresh.messageIds);
    }
  }

  /**
   * Reap every live session's SDK subprocess on shutdown so `mind stop`/restart
   * don't orphan `<defunct>` claude children to PID 1. Delegates the teardown to
   * reapSessionsForShutdown; bounded externally by setupShutdown's timeout.
   */
  async function reapAllSessions(): Promise<void> {
    const live = [...sessions.values()];
    if (live.length === 0) return;
    log("mind", `shutdown: reaping ${live.length} live SDK subprocess(es)`);
    for (const s of live) {
      sessions.delete(s.name);
      s.closed = true;
    }
    await reapSessionsForShutdown(live, (name, err) =>
      log("mind", `session "${name}": shutdown reap failed:`, err),
    );
  }

  if (idleTimeoutMs > 0) {
    log("mind", `idle session reaper: ${idleTimeoutMs / 60_000} min timeout`);
    const checkMs = Math.min(60_000, idleTimeoutMs);
    const reaper = setInterval(() => {
      const now = Date.now();
      const stale = [...sessions.values()].filter((s) =>
        isSessionReapable(
          s,
          now,
          idleTimeoutMs,
          (name) => sessions.get(name)?.rotationPending === true,
        ),
      );
      // Reaps run independently; each awaits its own subprocess exit internally.
      for (const session of stale) {
        reapSession(session).catch((err) =>
          log("mind", `session "${session.name}": reap failed:`, err),
        );
      }
    }, checkMs);
    reaper.unref?.();
  }

  // --- MessageHandler implementation ---

  function createSessionHandler(sessionName: string): MessageHandler {
    return {
      handle(content: VoluteContentPart[], meta: HandlerMeta, listener?: Listener): () => void {
        const session = getOrCreateSession(sessionName);

        // Only register a listener when a caller actually wants events. A per-message
        // listener that's never removed would grow session.listeners without bound and
        // make broadcastToSession O(messages-ever-received). The live dispatch path
        // passes no listener, so this is usually a no-op.
        let filteredListener: Listener | undefined;
        if (listener) {
          // Filter to only this messageId, and self-remove on the matching done so a
          // caller that forgets to unsubscribe can't reintroduce the leak.
          filteredListener = (event) => {
            if (event.messageId !== meta.messageId) return;
            listener(event);
            if (event.type === "done" && filteredListener) {
              session.listeners.delete(filteredListener);
            }
          };
          session.listeners.add(filteredListener);
        }

        // Track channel/sender for reply instructions
        if (meta.channel) {
          session.messageChannels.set(meta.messageId, {
            channel: meta.channel,
            sender: meta.sender,
          });
        }

        // Update reply instructions mode from routing config
        if (meta.replyInstructions) {
          session.replyInstructionsMode = meta.replyInstructions;
        }

        // Interrupt if requested and session is mid-turn
        if (
          meta.interrupt &&
          interruptCurrentTurn(session, (err) =>
            log("mind", `session "${sessionName}": interrupt failed:`, err),
          )
        ) {
          log("mind", `session "${sessionName}": interrupting current turn`);
        }

        // Push message into SDK
        session.lastActivityAt = Date.now();
        const seq = session.channel.push({
          type: "user",
          session_id: "",
          message: { role: "user", content: toSDKContent(content) },
          parent_tool_use_id: null,
        });
        session.messageIds.push({ id: meta.messageId, seq });

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

  const claudeMdTokens = countSdkInstructionTokens(options.cwd);
  const skillDescTokens = countSkillDescriptionTokens([resolvePath(options.cwd, ".claude/skills")]);

  function jsonlPathFor(sessionName: string): string | null {
    const sessionId = sessionStore.load(sessionName)?.sessionId;
    return sessionId ? findClaudeSessionFile(options.cwd, sessionId) : null;
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
                  await processClaudeSession(
                    jsonlPath,
                    countSystemPromptTokens(systemPrompt.current()),
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
    return { sessions: infos, systemPrompt: countSystemPromptTokens(systemPrompt.current()) };
  }

  async function getContextMessages(): Promise<ContextMessages> {
    const skillsDir = resolvePath(options.cwd, ".claude/skills");
    const sessionMessages: ContextMessages["sessions"] = [];
    for (const s of sessions.values()) {
      try {
        const jsonlPath = jsonlPathFor(s.name);
        const result = jsonlPath
          ? await processClaudeSession(
              jsonlPath,
              countSystemPromptTokens(systemPrompt.current()),
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
        systemPrompt: systemPrompt.current(),
        sdkInstructions: readSdkInstructions(options.cwd),
        skillDescriptions: readSkillDescriptions([skillsDir]),
      },
      sessions: sessionMessages,
    };
  }

  // Pre-warm the main session so the SDK subprocess starts immediately
  // instead of waiting for the first message (which adds minutes of latency).
  getOrCreateSession("main");

  return {
    resolve,
    flushFileChanges: autoCommit.flushFileChanges,
    getContextInfo,
    getContextMessages,
    reapAllSessions,
  };
}
