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
import { daemonEmit } from "./lib/daemon-client.js";
import { compactTimestamp } from "./lib/format-prefix.js";
import { runHooks } from "./lib/hook-loader.js";
import { createAutoCommitHook } from "./lib/hooks/auto-commit.js";
import { createIdentityReloadHook } from "./lib/hooks/identity-reload.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- used as value
import { createPreCompactHook } from "./lib/hooks/pre-compact.js";
import { createReplyInstructionsHook } from "./lib/hooks/reply-instructions.js";
import { log } from "./lib/logger.js";
import { createMessageChannel } from "./lib/message-channel.js";
import { buildSeededNote, type SeedCause } from "./lib/seed-note.js";
import {
  isSessionReapable,
  reapSessionQuery,
  reapSessionsForShutdown,
} from "./lib/session-reaper.js";
import {
  computeSeedCut,
  DEFAULT_SEED_TOKENS,
  rotateSession,
  type SeedCut,
  seedSession,
} from "./lib/session-seed.js";
import { createSessionStore } from "./lib/session-store.js";
import type { EffortLevel, ThinkingConfig } from "./lib/startup.js";
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
import type { ContextInfo, ContextMessages, SessionContextInfo } from "./lib/volute-server.js";

type Session = {
  name: string;
  channel: ReturnType<typeof createMessageChannel>;
  listeners: Set<Listener>;
  messageIds: (string | undefined)[];
  currentMessageId?: string;
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
  /**
   * The cut point pinned at warn time (the first-kept turn the mind was told would
   * survive verbatim). Honored at rotation so the promise in the warning holds even
   * though the transcript grows after the warning. Null until a warning fires.
   */
  rotationCut: SeedCut | null;
  /**
   * Back-to-back rotations that did NOT bring context under the threshold (reset by
   * any healthy turn). Guards against a runaway loop when the tail alone can't fit —
   * e.g. a system prompt (large MEMORY.md) that already fills most of the window, which
   * rotation can't trim. Past the cap we stop rotating and defer to native compaction.
   */
  consecutiveRotations: number;
  /**
   * Rotation state machine (undefined = idle). The warning is pushed and the mind
   * takes a wrap-up turn — with FULL context of the turns it's summarizing — before
   * the session rotates:
   *   - "warned": a turn was mid-flight when we warned; it must finish before the
   *     wrap-up turn (which consumes the warning) runs.
   *   - "rotateAfterTurn": the wrap-up turn is the current/next turn; rotate when it ends.
   * Lives on the session (not a map) so it can't leak into a resumed session if the
   * stream dies mid-flight — a fresh session starts idle.
   */
  rotationPhase?: RotationPhase;
};

type RotationPhase = "warned" | "rotateAfterTurn";

/** Stop self-rotating after this many back-to-back rotations that didn't reduce context. */
const MAX_CONSECUTIVE_ROTATIONS = 3;

export function createMind(options: {
  systemPrompt: string;
  cwd: string;
  abortController: AbortController;
  model?: string;
  thinking?: ThinkingConfig;
  effort?: EffortLevel;
  sessionsDir: string;
  compactionMessage?: string;
  maxContextTokens?: number;
  subagents?: Record<string, SubagentConfig>;
  onIdentityReload?: () => Promise<void>;
  /** Idle minutes before a session's SDK subprocess is reaped. 0 disables. Default 30. */
  sessionIdleMinutes?: number;
  /** Estimated-token budget for seeding a fresh persistent session. 0 disables. Default 30000. */
  seedTokens?: number;
}): {
  resolve: HandlerResolver;
  waitForCommits: () => Promise<void>;
  getContextInfo: () => Promise<ContextInfo>;
  getContextMessages: () => Promise<ContextMessages>;
  reapAllSessions: () => Promise<void>;
} {
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
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${date} in prompt template
    options.compactionMessage ?? prompts.compaction_warning.replace("${date}", today);
  const maxContextTokens = options.maxContextTokens;
  const seedTokens = options.seedTokens ?? DEFAULT_SEED_TOKENS;

  if (maxContextTokens) {
    log("mind", `compaction threshold: ${maxContextTokens} tokens`);
  }

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

  // --- Skill discovery ---
  // The CLI only discovers skills through its user-scope ~/.claude/skills scan,
  // so the "user" setting source is load-bearing and HOME must be the mind's
  // home dir for the SDK subprocess (isolation modes already set it; pinning it
  // here keeps non-isolated minds from loading the host's ~/.claude). The
  // explicit skills array grants the Skill tool for each installed skill — the
  // SDK silently drops the documented `skills: 'all'` string form.
  const mindHome = resolvePath(options.cwd);
  const sdkEnv = { ...process.env, HOME: mindHome };
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
        // Only UserPromptSubmit hooks can inject additionalContext into the conversation
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
        systemPrompt: options.systemPrompt,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: ["project", "user"],
        skills: installedSkills(),
        env: sdkEnv,
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

      /**
       * Warn the mind that the session will rotate at the context limit and pin the
       * cut point it's told about. Computes which whole turns fit in `seedTokens`
       * from the live transcript, pins the first-kept turn (so rotation honors the
       * same boundary even as the transcript grows), interpolates its time into the
       * `${cutoff}` placeholder, enters the rotation state machine, and pushes the
       * warning as the wrap-up prompt. Shared by the threshold and PreCompact paths.
       *
       * Crucially it does NOT abort here: the mind takes a wrap-up turn (reading the
       * pinned cutoff and authoring `volute mind history` summaries with full context
       * of the turns being collapsed) before rotation. The entry phase depends on
       * whether a turn is mid-flight: if one is (threshold path fires on an assistant
       * message), it must finish before the queued warning runs, so we start "warned";
       * if we're between turns (PreCompact fired at a boundary), the warning IS the
       * next turn, so we start "rotateAfterTurn".
       */
      function warnAndPinRotation() {
        let cutoffLabel = "the cutoff";
        session.rotationCut = null;
        if (currentSessionId) {
          try {
            const path = findClaudeSessionFile(options.cwd, currentSessionId);
            const cut = path ? computeSeedCut(readFileSync(path, "utf-8"), seedTokens) : null;
            if (cut) {
              session.rotationCut = cut;
              if (cut.boundaryTimestamp) {
                const d = new Date(cut.boundaryTimestamp);
                if (!Number.isNaN(d.getTime())) cutoffLabel = compactTimestamp(d);
              }
            }
          } catch (err) {
            log("mind", `session "${session.name}": failed to pin rotation cut:`, err);
          }
        }
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${cutoff} prompt placeholder
        const warning = compactionMessage.replaceAll("${cutoff}", cutoffLabel);
        session.rotationPhase =
          session.currentMessageId !== undefined ? "warned" : "rotateAfterTurn";
        session.messageIds.push(undefined);
        session.channel.push({
          type: "user",
          session_id: "",
          message: { role: "user", content: [{ type: "text", text: warning }] },
          parent_tool_use_id: null,
        });
      }

      // PreCompact backstop: first fire warns + pins + enters the rotation machine
      // (unless already warned, or the rotation cap is hit) and blocks; second fire
      // allows the SDK's native compaction — the emergency backstop when rotation never
      // intervened (a hung turn, or a system prompt too large for rotation to relieve).
      const preCompact = createPreCompactHook(() => {
        if (!session.rotationPhase && session.consecutiveRotations < MAX_CONSECUTIVE_ROTATIONS) {
          warnAndPinRotation();
        }
      });

      const callbacks = {
        onSessionId: (id: string) => {
          currentSessionId = id;
          if (!session.name.startsWith("new-")) sessionStore.save(session.name, id);
        },
        broadcast: (event: VoluteEvent) => broadcastToSession(session, event),
        onTurnEnd: async () => {
          // This turn's message is fully processed — drop it from the channel's
          // in-flight set so a later compaction abort won't re-feed it.
          session.channel.ack();
          session.lastActivityAt = Date.now();
          // A turn resolved — the seeded note's injection had its chance to land
          // (the pre-prompt hook ran and wasn't cancelled by an interrupt), so stop
          // re-offering it. This is the honest place to clear: a completed turn is
          // the closest-to-arrival signal available without reading the transcript back.
          session.seeded = false;
          await autoCommit.flushFileChanges();
          if (session.rotationPhase === "warned") {
            // The mid-flight turn finished; the queued warning runs next as the wrap-up
            // turn. Advance — do NOT abort yet, so the mind summarizes with full context.
            session.rotationPhase = "rotateAfterTurn";
          } else if (session.rotationPhase === "rotateAfterTurn") {
            // The wrap-up turn is done (summaries authored) — abort to rotate in place.
            log("mind", `session "${session.name}": wrap-up turn done — aborting to rotate`);
            streamAbort.abort(new CompactionAbort());
          } else {
            // A healthy turn (context under the threshold) — the rotation streak, if
            // any, is over, so re-arm the self-rotation cap.
            session.consecutiveRotations = 0;
            if (identityReload.shouldRequestReload()) options.onIdentityReload?.();
          }
        },
        onContextTokens: (tokens: number) => {
          session.contextTokens = tokens;
          if (
            maxContextTokens &&
            tokens >= maxContextTokens &&
            !session.rotationPhase &&
            session.consecutiveRotations < MAX_CONSECUTIVE_ROTATIONS
          ) {
            log(
              "mind",
              `session "${session.name}": ${tokens} tokens >= ${maxContextTokens} — warning + pinning rotation`,
            );
            warnAndPinRotation();
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
        await consumeStream(q, session, callbacks);
        if (session.currentMessageId !== undefined) {
          session.messageChannels.delete(session.currentMessageId);
          emitDone();
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
              // Stream was aborted to rotate: replace the session with a synthetic one
              // holding the verbatim recent tail (from the pinned cut), then resume it.
              const rotatedId = rotateSession({
                cwd: options.cwd,
                sessionsDir: options.sessionsDir,
                name: session.name,
                oldSessionId: currentSessionId,
                cut: session.rotationCut,
                seedTokens,
              });
              session.rotationCut = null;
              session.rotationPhase = undefined; // state machine consumed
              if (!rotatedId) {
                // Rotation couldn't proceed — fall back to a fresh session (no seed,
                // no note). Fresh is a far smaller cliff now that seeding exists.
                log("mind", `session "${session.name}": rotation failed, starting fresh`);
                sessionStore.delete(session.name);
                currentSessionId = undefined;
                session.seeded = false;
                streamAbort = new AbortController();
                session.channel = createMessageChannel();
                break;
              }
              // Point the live pointer at the rotated session and arm the boundary
              // note (rotation cause — no gap). Ephemeral `new-*` keep no pointer.
              if (!session.name.startsWith("new-")) sessionStore.save(session.name, rotatedId);
              currentSessionId = rotatedId;
              session.seeded = true;
              session.seededCause = "rotation";
              session.seededArchivedAt = null;
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
              // (the wrap-up warning plus anything that arrived mid-turn) so nothing is
              // dropped when the killed subprocess takes its buffer with it.
              const pending = session.channel.recover();
              session.channel = createMessageChannel();
              for (const msg of pending) session.channel.push(msg);
              continue; // restart the stream loop on the rotated session
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
          // We fell back to a truly empty session — don't tell the mind its
          // conversation continued when the seeded transcript failed to resume,
          // and don't let a half-entered rotation leak into the fresh session.
          session.seeded = false;
          session.rotationPhase = undefined;
          session.rotationCut = null;
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
        sessions.delete(session.name);
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
      rotationCut: null,
      consecutiveRotations: 0,
    };
    sessions.set(name, session);

    const isEphemeral = name.startsWith("new-");
    let savedSessionId = isEphemeral ? undefined : sessionStore.load(name);
    // Validate that the SDK session file still exists — orphaned references
    // cause the SDK to throw and can crash the process with EPIPE.
    if (savedSessionId && !findClaudeSessionFile(options.cwd, savedSessionId)) {
      log("mind", `session "${name}": stored session ${savedSessionId} not found, starting fresh`);
      sessionStore.delete(name);
      savedSessionId = undefined;
    }
    if (savedSessionId) {
      log("mind", `session "${name}": resuming ${savedSessionId}`);
    } else if (!isEphemeral) {
      // Fresh persistent session — seed it from the previous session's archived
      // transcript so the mind experiences the conversation continuing rather
      // than waking into an empty context. Ephemeral `new-*` sessions never seed.
      const seeded = seedSession({
        cwd: options.cwd,
        sessionsDir: options.sessionsDir,
        name,
        seedTokens: options.seedTokens ?? DEFAULT_SEED_TOKENS,
      });
      if (seeded) {
        sessionStore.save(name, seeded.sessionId);
        savedSessionId = seeded.sessionId;
        session.seeded = true;
        session.seededArchivedAt = seeded.archivedAt;
        session.seededCause = "restored";
        log(
          "mind",
          `session "${name}": seeded from previous transcript, resuming ${seeded.sessionId}`,
        );
      } else {
        log("mind", `session "${name}": starting fresh`);
      }
    } else {
      log("mind", `session "${name}": starting fresh`);
    }

    startSession(session, savedSessionId);
    return session;
  }

  // --- Idle session reaping ---
  // Each session holds a resident SDK subprocess (~250MB) for its whole life.
  // After the idle timeout, shut the subprocess down while keeping the session
  // resumable: the session id is persisted, so the next inbound message
  // transparently re-creates the session via getOrCreateSession's resume path.
  const idleTimeoutMs = (options.sessionIdleMinutes ?? 30) * 60_000;

  async function reapSession(session: Session) {
    log("mind", `session "${session.name}": idle — reaping SDK subprocess (resumable)`);
    // Delete first so a racing inbound message spins up a fresh resumed session
    // instead of reusing the one we're tearing down.
    sessions.delete(session.name);
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
    // did, re-dispatch into a fresh session so no input is dropped.
    const pending = session.channel.recover();
    if (pending.length > 0) {
      const fresh = getOrCreateSession(session.name);
      for (const msg of pending) fresh.channel.push(msg);
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
    for (const s of live) sessions.delete(s.name);
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
          (name) => sessions.get(name)?.rotationPhase !== undefined,
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
        if (meta.interrupt && session.currentMessageId !== undefined && session.currentQuery) {
          log("mind", `session "${sessionName}": interrupting current turn`);
          session.currentQuery.interrupt();
        }

        // Push message into SDK
        session.lastActivityAt = Date.now();
        session.messageIds.push(meta.messageId);
        session.channel.push({
          type: "user",
          session_id: "",
          message: { role: "user", content: toSDKContent(content) },
          parent_tool_use_id: null,
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

  const systemPromptTokens = countSystemPromptTokens(options.systemPrompt);
  const claudeMdTokens = countSdkInstructionTokens(options.cwd);
  const skillDescTokens = countSkillDescriptionTokens([resolvePath(options.cwd, ".claude/skills")]);

  function jsonlPathFor(sessionName: string): string | null {
    const sessionId = sessionStore.load(sessionName);
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
    const skillsDir = resolvePath(options.cwd, ".claude/skills");
    const sessionMessages: ContextMessages["sessions"] = [];
    for (const s of sessions.values()) {
      try {
        const jsonlPath = jsonlPathFor(s.name);
        const result = jsonlPath
          ? await processClaudeSession(
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

  // Pre-warm the main session so the SDK subprocess starts immediately
  // instead of waiting for the first message (which adds minutes of latency).
  getOrCreateSession("main");

  return {
    resolve,
    waitForCommits: autoCommit.waitForCommits,
    getContextInfo,
    getContextMessages,
    reapAllSessions,
  };
}
