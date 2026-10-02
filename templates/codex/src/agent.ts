import { rmSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  Codex,
  type Input,
  type McpToolCallItem,
  type ThreadEvent,
  type ThreadItem,
} from "@openai/codex-sdk";
import { flushFileChanges, trackFileChange } from "./lib/auto-commit.js";
import {
  clearRolloutLeftBehind,
  findLatestArchivedThread,
  rotateCodexSession,
  seedCodexSession,
} from "./lib/codex-session-seed.js";
import { extractImages, extractText, type ImagePart, writeImages } from "./lib/content.js";
import {
  countSdkInstructionTokens,
  countSkillDescriptionTokens,
  countSystemPromptTokens,
  findCodexSessionFile,
  getCachedContextInfo,
  processCodexSession,
  readLastContextTokens,
  readSdkInstructions,
  readSkillDescriptions,
} from "./lib/context-breakdown.js";
import {
  daemonEmit,
  daemonNotice,
  daemonRecollection,
  type EventType,
} from "./lib/daemon-client.js";
import { isEventChannel } from "./lib/event-turn.js";
import { changedPaths } from "./lib/home-changes.js";
import { discoverHooks, runHooks } from "./lib/hook-loader.js";
import { log, warn } from "./lib/logger.js";
import { codexSessionsRoot, rolloutVisibleToCodex } from "./lib/rollout.js";
import {
  budgetSpent,
  createRotationGuard,
  MAX_CONSECUTIVE_ROTATIONS,
  type RotationGuard,
  recordRotation,
  shouldRotate,
} from "./lib/rotation.js";
import { buildSeededNote, formatGap, type SeedCause } from "./lib/seed-note.js";
import { recallTokenBudget } from "./lib/session-seed.js";
import { createSessionStore, lostRealContext } from "./lib/session-store.js";
import {
  getStartupContext,
  loadPrompts,
  loadSubagents,
  loadSystemPrompt,
  type StartupSource,
  type SubagentConfig,
} from "./lib/startup.js";
import {
  type SubagentOutcome,
  type SubagentServer,
  startSubagentServer,
} from "./lib/subagent-server.js";
import { threadRef } from "./lib/thread-ref.js";
import { filterEvent, loadTransparencyPreset } from "./lib/transparency.js";
import { newModelContext, turnContextFor } from "./lib/turn-context.js";
import type {
  HandlerMeta,
  HandlerResolver,
  Listener,
  MessageHandler,
  VoluteContentPart,
  VoluteEvent,
} from "./lib/types.js";
import { type UsageDelta, type UsageSnapshot, usageDelta, ZERO_USAGE } from "./lib/usage.js";
import type { ContextInfo, ContextMessages, SessionContextInfo } from "./lib/volute-server.js";

/**
 * Minimal interface for a Codex SDK thread — typed to the methods we actually use, and to
 * the SDK's own event union, so reading a field the SDK doesn't send is a type error rather
 * than a silent `undefined` (#1189: `item.path` on a file change, `serverName` on an MCP
 * call).
 */
type CodexThread = {
  runStreamed(
    input: Input,
    options?: { signal?: AbortSignal },
  ): Promise<{ events: AsyncIterable<ThreadEvent> }>;
};

type QueuedMessage = { text: string; images: ImagePart[]; meta: HandlerMeta };

type CodexSession = {
  name: string;
  /** This session's own client — its shell environment names this session. */
  client?: Codex;
  thread: CodexThread | null;
  listeners: Set<Listener>;
  currentMessageId?: string;
  messageQueue: QueuedMessage[];
  processing: boolean;
  abortController?: AbortController;
  messageChannels: Map<string, string>;
  /** Reply instructions have been given in this thread's context (see turn-context.ts). */
  replyInstructionsFired: boolean;
  /** The event note is a standing fact about events, so it fires once per session. */
  eventNoteFired: boolean;
  /**
   * Why the current thread started, until its first turn has been oriented — the source
   * the startup-context hook is run with. Null once that turn has run it.
   */
  startupSource: StartupSource | null;
  /**
   * Settles once the session's thread is chosen — resumed, or seeded from the archive,
   * which waits on the daemon for recollection. Turns wait on it, so a message arriving
   * meanwhile queues rather than landing on a thread the seed is about to replace.
   */
  ready: Promise<void>;
  /**
   * The last turn's own input delta, never codex's session-cumulative counter (see
   * `UsageDelta.contextTokens`). A cumulative figure here reported a thread's lifetime
   * total as its context size, which passes any window within a few turns (#913).
   *
   * Display only — the dashboard's estimate when the rollout carries no usage event
   * yet. Rotation does *not* read this: the delta sums every model request in a turn, so
   * a tool loop reads several times the real context. `measureContext` is the gate's
   * source. The same-named field in the claude and pi templates is the last request's
   * true context, so the three are not directly comparable.
   */
  contextTokens: number;
  /** Last cumulative usage snapshot from `turn.completed`, for per-turn deltas (see lib/usage.ts). */
  lastUsage: UsageSnapshot;
  /** The turn in flight's own usage, one entry per codex run, reported once at its end. */
  turnUsage: UsagePayload[];
  /** Usage of subagents the turn in flight called — the same model, reported with it. */
  subagentUsage: UsagePayload[];
  /** Subagents running for this session, stopped when the run that called them ends. */
  subagentRuns: Set<AbortController>;
  /**
   * True when this session was seeded from a previous session's rollout (a restart
   * restore) or a rotation. Consumed once, on the first turn, to inject the note.
   */
  seeded: boolean;
  /** When the seeded-from session was archived (epoch ms), for the gap note; null if unknown. */
  seededArchivedAt: number | null;
  /** Whether recollection went ahead of the seeded tail — the note says so only when it did. */
  seededRecollection: boolean;
  /**
   * The live Codex thread id, tracked in-memory (from thread.started) so rotation can
   * locate the rollout even for ephemeral `new-*` sessions, which persist no pointer.
   */
  currentThreadId: string | null;
  /** Why the tail is seeded — picks the boundary note's wording. Last cause wins. */
  seededCause: SeedCause;
  /** Consecutive rotations that relieved nothing; see lib/rotation.ts. */
  rotationGuard: RotationGuard;
  /** One unmeasurable-context notice per session, so a silent no-rotate is diagnosable. */
  measureWarned: boolean;
  /**
   * Whether the current thread is known to hold real conversation — see
   * `SessionRecord.committed`. Tracked for ephemeral `new-*` sessions too, which keep no
   * pointer but can still lose a thread mid-life.
   */
  committed: boolean;
};

type UsagePayload = UsageDelta["payload"];

/** Two usage payloads on the same model, field by field. */
function addUsage(a: UsagePayload, b: UsagePayload): UsagePayload {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
  };
}

const ZERO_PAYLOAD: UsagePayload = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

// Loaded once at startup
const preset = loadTransparencyPreset();

/** How long a subagent may run before it is stopped. */
const SUBAGENT_TIMEOUT_MS = 15 * 60_000;

function emit(
  session: CodexSession,
  event: {
    type: EventType;
    content?: string;
    metadata?: Record<string, unknown>;
    covers?: string[];
  },
): Promise<void> {
  const channel = session.currentMessageId
    ? session.messageChannels.get(session.currentMessageId)
    : undefined;
  const filtered = filterEvent(preset, {
    ...event,
    session: session.name,
    channel,
    messageId: session.currentMessageId,
  });
  return filtered ? daemonEmit(filtered) : Promise.resolve();
}

/**
 * Record a `context_lost` notice. Mind-level (no `thread`), so whichever thread next runs a
 * turn reads it, rather than it waiting on a turn in this one that may never come (#768).
 */
async function noticeContextLost(name: string, message: string): Promise<void> {
  await daemonNotice({ kind: "context_lost", message }).catch((err) =>
    log("mind", `session "${name}": failed to record notice:`, err),
  );
}

/** `prefix` ahead of an input's text, whether the input is a bare string or has images. */
function prependText(input: Input, prefix: string): Input {
  if (typeof input === "string") return `${prefix}\n\n${input}`;
  return input.map((part, i) =>
    i === 0 && part.type === "text" ? { ...part, text: `${prefix}\n\n${part.text}` } : part,
  );
}

/** An MCP tool's result as text: its text blocks, or the whole payload when it has none. */
function mcpResultText(result: McpToolCallItem["result"]): string {
  if (!result) return "";
  const text = result.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
  return text || JSON.stringify(result.structured_content ?? result.content);
}

/** A completed tool call, as claude's PostToolUse hook input names its parts. */
type ToolCall = {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: unknown;
  tool_use_id: string;
};

/**
 * A completed codex item as the tool calls claude would have made for it — the names a
 * mind's hook already matches on (#1199):
 * - a shell command is `Bash`. codex reports stdout and stderr as one stream, so it all
 *   arrives as `stdout`; `exit_code` is codex's.
 * - a file change (one apply_patch, possibly several files) is one call per file: `Write`
 *   for a new file, `Edit` for an update. A deletion has no claude tool of its own and a
 *   hook matching Edit would go looking for a file that's gone, so it isn't reported.
 * - an MCP call is `mcp__<server>__<tool>`; a web search is `WebSearch`.
 * A failed file change or MCP call isn't reported either: claude's PostToolUse runs only
 * after a tool succeeds. Anything else — reasoning, messages, todo lists — is not a tool call.
 */
function postToolUseCalls(item: ThreadItem, cwd: string): ToolCall[] {
  switch (item.type) {
    case "command_execution":
      return [
        {
          tool_name: "Bash",
          tool_input: { command: item.command },
          tool_response: {
            stdout: item.aggregated_output,
            stderr: "",
            exit_code: item.exit_code ?? null,
            interrupted: false,
          },
          tool_use_id: item.id,
        },
      ];
    case "file_change":
      if (item.status === "failed") return [];
      return item.changes.flatMap((change) => {
        if (change.kind === "delete") return [];
        const filePath = resolvePath(cwd, change.path);
        return {
          tool_name: change.kind === "add" ? "Write" : "Edit",
          tool_input: { file_path: filePath, kind: change.kind },
          tool_response: { filePath, kind: change.kind, success: true },
          tool_use_id: item.id,
        };
      });
    case "mcp_tool_call":
      if (item.status === "failed" || item.error) return [];
      return [
        {
          tool_name: `mcp__${item.server}__${item.tool}`,
          tool_input: (item.arguments ?? {}) as Record<string, unknown>,
          tool_response: item.result ?? null,
          tool_use_id: item.id,
        },
      ];
    case "web_search":
      return [
        {
          tool_name: "WebSearch",
          tool_input: { query: item.query },
          tool_response: { query: item.query },
          tool_use_id: item.id,
        },
      ];
    default:
      return [];
  }
}

export function createMind(options: {
  systemPrompt: string;
  cwd: string;
  mindDir: string;
  model?: string;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  maxContextTokens?: number;
  /**
   * Estimated-token budget for a seeded session's verbatim tail. 0 disables. Unset, it
   * follows what arrived: 10000 behind recollection, 30000 when there was none.
   */
  seedTokens?: number;
  /** Seed the mind's recollection ahead of the verbatim tail at every seam. Default true. */
  recollection?: boolean;
  /** `subagents` from config.json — each is offered to codex as a tool (see runSubagent). */
  subagents?: Record<string, SubagentConfig>;
}): {
  resolve: HandlerResolver;
  getContextInfo: () => Promise<ContextInfo>;
  getContextMessages: () => Promise<ContextMessages>;
  flushFileChanges: () => Promise<void>;
} {
  const sessions = new Map<string, CodexSession>();
  const prompts = loadPrompts();
  const maxContextTokens = options.maxContextTokens;
  const seedTokens = options.seedTokens;
  const recollect = options.recollection !== false ? daemonRecollection : undefined;
  const recallTokens = recallTokenBudget(maxContextTokens);
  /** Budget and recollection shared by every seam. */
  const seam = () => ({ seedTokens, recallTokens, recollect, sessionsRoot: codexSessionsRoot() });

  if (maxContextTokens) {
    log("mind", `compaction threshold: ${maxContextTokens} tokens`);
  }

  const sessionsDir = resolvePath(options.mindDir, ".mind/codex-sessions");
  const sessionStore = createSessionStore(sessionsDir);

  /**
   * Rollout path per thread id. `findCodexSessionFile` walks the whole `YYYY/MM/DD`
   * sessions tree synchronously; a thread's file never moves once written, and the
   * rotation gate asks after every turn, so resolve each id once. Misses aren't cached —
   * the file appears shortly after the thread starts.
   */
  const rolloutPaths = new Map<string, string>();
  function rolloutPathFor(threadId: string): string | null {
    const cached = rolloutPaths.get(threadId);
    if (cached) return cached;
    const path = findCodexSessionFile(threadId, options.mindDir, codexSessionsRoot());
    if (path) rolloutPaths.set(threadId, path);
    return path;
  }
  const hooksDir = resolvePath(options.cwd, ".local/hooks");

  // --- Subagents (config-driven) ---

  const subagents = new Map(Object.entries(loadSubagents(options.subagents, options.cwd)));
  /** The MCP endpoint the subagents are offered on, once it is listening. */
  let subagentServer: SubagentServer | null = null;
  // Sessions wait for it (see getOrCreateSession), so no thread starts without its tools.
  const subagentsReady: Promise<void> =
    subagents.size === 0
      ? Promise.resolve()
      : startSubagentServer(
          [...subagents].map(([name, def]) => ({
            name,
            description: `Your ${name} subagent: ${def.description}`,
          })),
          (session, name, prompt) => runSubagent(session, name, prompt),
        ).then(
          (server) => {
            subagentServer = server;
          },
          (err) => warn("mind", "failed to offer subagents, running without them:", err),
        );

  // Write system prompt to file for Codex model_instructions_file
  const promptPath = resolvePath(options.mindDir, ".mind/system-prompt.md");
  // The prompt most recently written — what the next turn runs with, and what the context
  // panel reports.
  let systemPrompt = options.systemPrompt;
  function refreshSystemPrompt() {
    try {
      // Re-read and re-compose the system prompt (picks up identity-file edits)
      systemPrompt = loadSystemPrompt();
    } catch (err) {
      warn("mind", "failed to refresh system prompt, keeping the last good one:", err);
    }
    writeFileSync(promptPath, systemPrompt);
  }
  refreshSystemPrompt();

  // Use OPENAI_API_KEY if available, otherwise let codex CLI use its own auth (~/.codex/auth.json)
  const apiKey = process.env.OPENAI_API_KEY;

  // One client per session, kept on the session so it lives exactly as long: the shell
  // environment is set per client, and it carries the session's slug so that session's
  // own commands (`volute chat send`) name it in X-Volute-Thread. A shared carrier names
  // whichever session wrote it last, and a send got stamped with a sibling thread's turn
  // (#1173).
  const codexFor = (session: CodexSession): Codex => {
    if (session.client) return session.client;
    const sessionName = session.name;
    const client = new Codex({
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
        ...shellConfig(sessionName),
        ...(subagentServer && {
          mcp_servers: {
            subagents: {
              url: subagentServer.url(sessionName),
              // The token's *name*: `--config` values are on argv, visible in `ps`.
              bearer_token_env_var: subagentServer.tokenEnvVar,
              default_tools_approval_mode: "approve",
              // A dream runs for minutes; codex's default would cut the call at 60s.
              tool_timeout_sec: SUBAGENT_TIMEOUT_MS / 1000 + 60,
              startup_timeout_sec: 30,
            },
          },
        }),
      },
    });
    session.client = client;
    return client;
  };

  /** The shell a thread's codex (or its subagent's) runs commands in. */
  function shellConfig(sessionName: string) {
    return {
      // No login shells. A login shell sources /etc/profile, which on Debian (our Docker
      // image) resets PATH and drops home/.local/bin — the mind's skill commands went
      // missing (#1232). With this off, codex runs `<shell> -c` and doesn't replay its
      // login-shell snapshot, so commands see the environment set below.
      allow_login_shell: false,
      // Commands inherit the mind's environment (VOLUTE_* vars, PATH with home/.local/bin)
      // whole. ZDOTDIR keeps zsh, which reads .zshenv on every start, on home/ — never the
      // host's own dotfiles when the mind shares the host's HOME.
      shell_environment_policy: {
        inherit: "all" as const,
        ignore_default_excludes: true,
        set: { ZDOTDIR: options.cwd, VOLUTE_SESSION: sessionName },
      },
    };
  }

  /**
   * The turn's usage, once: the sum of its codex runs, plus its subagents as a per-model
   * breakdown the daemon prices slice by slice, as pi reports them. Everything here ran on
   * the mind's own model, so there is a single slice; `main_model` names it. Without a
   * model name to key a slice on, the subagents' usage joins the aggregate instead, which
   * the daemon prices against the mind's configured model — the same one.
   */
  function emitTurnUsage(session: CodexSession) {
    const own = session.turnUsage.splice(0);
    const subagentRuns = session.subagentUsage.splice(0);
    if (own.length === 0 && subagentRuns.length === 0) return;
    const ownTotal = own.length > 0 ? own.reduce(addUsage) : ZERO_PAYLOAD;
    const model = options.model;
    const payload =
      model && subagentRuns.length > 0
        ? {
            ...ownTotal,
            model,
            main_model: model,
            models: [{ model, ...[ownTotal, ...subagentRuns].reduce(addUsage) }],
          }
        : { ...[ownTotal, ...subagentRuns].reduce(addUsage), model };
    broadcast(session, { type: "usage", ...payload });
    emit(session, { type: "usage", metadata: payload });
  }

  /** One subagent at a time for the whole mind; a call waits its turn. */
  let subagentQueue: Promise<void> = Promise.resolve();

  /**
   * Run one subagent on behalf of a session's current turn: a nested codex thread whose
   * whole prompt is the subagent's `systemPrompt` file — for the dreamer, SOUL.md and
   * nothing else (#1200). codex would otherwise add the mind's AGENTS.md, its skills
   * catalog and its native multi-agent tools, so each is switched off: verified against
   * codex 0.156.1's request body, where none of the three appear with these settings.
   *
   * It runs in the mind's home, on the mind's model, with a shell that names the calling
   * session. One runs at a time. It is stopped when the run that called it ends, however
   * that run ends, or after SUBAGENT_TIMEOUT_MS. Its usage is reported with the calling
   * turn's (see emitTurnUsage), so it counts against the spend cap.
   */
  async function runSubagent(
    sessionName: string,
    name: string,
    prompt: string,
  ): Promise<SubagentOutcome> {
    const def = subagents.get(name);
    const session = sessions.get(sessionName);
    if (!def || !session?.processing) {
      return { text: `No ${name} subagent for thread ${sessionName}.`, isError: true };
    }
    const run = new AbortController();
    session.subagentRuns.add(run);
    const previous = subagentQueue;
    let release = () => {};
    subagentQueue = new Promise((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      if (run.signal.aborted) {
        return { text: "[subagent error] the run that called it ended first", isError: true };
      }
      return await runSubagentThread(session, def.promptPath, name, prompt, run);
    } finally {
      session.subagentRuns.delete(run);
      release();
    }
  }

  async function runSubagentThread(
    session: CodexSession,
    promptPath: string,
    name: string,
    prompt: string,
    run: AbortController,
  ): Promise<SubagentOutcome> {
    const sessionName = session.name;
    const client = new Codex({
      ...(apiKey ? { apiKey } : {}),
      config: {
        model_instructions_file: promptPath,
        project_doc_max_bytes: 0,
        skills: { include_instructions: false },
        features: { multi_agent: false },
        ...shellConfig(sessionName),
      },
    });
    const signal = AbortSignal.any([run.signal, AbortSignal.timeout(SUBAGENT_TIMEOUT_MS)]);
    let text = "";
    let failure: string | null = null;
    let completed = false;
    let threadId: string | null = null;
    try {
      const { events } = await client.startThread(threadOptions()).runStreamed(prompt, { signal });
      for await (const event of events) {
        if (event.type === "thread.started") {
          threadId = event.thread_id;
        } else if (event.type === "item.completed" && event.item.type === "agent_message") {
          text = event.item.text;
        } else if (event.type === "turn.completed") {
          completed = true;
          // A fresh thread's cumulative counter is this run's own usage.
          const delta = usageDelta(ZERO_USAGE, event.usage);
          if (delta) session.subagentUsage.push(delta.payload);
        } else if (event.type === "turn.failed") {
          failure = event.error.message;
        } else if (event.type === "error") {
          failure ??= event.message;
        }
      }
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    } finally {
      // Nothing reads a subagent's rollout again, and each one left behind lengthens the
      // walk every rollout lookup makes; the dream itself is in the mind's files.
      const rollout =
        threadId && findCodexSessionFile(threadId, options.mindDir, codexSessionsRoot());
      if (rollout) rmSync(rollout, { force: true });
    }
    if (!completed) {
      warn("mind", `subagent "${name}" for session "${sessionName}" failed: ${failure}`);
      return { text: `[subagent error] ${failure ?? "it ended without finishing"}`, isError: true };
    }
    log("mind", `subagent "${name}" for session "${sessionName}": done`);
    return { text: text || "(no output)" };
  }

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
      replyInstructionsFired: false,
      eventNoteFired: false,
      startupSource: null,
      ready: Promise.resolve(),
      contextTokens: 0,
      lastUsage: ZERO_USAGE,
      turnUsage: [],
      subagentUsage: [],
      subagentRuns: new Set(),
      seeded: false,
      seededArchivedAt: null,
      seededRecollection: false,
      currentThreadId: null,
      seededCause: "restored",
      rotationGuard: createRotationGuard(),
      measureWarned: false,
      committed: false,
    };
    sessions.set(name, session);

    session.ready = subagentsReady
      .then(() => initSession(session))
      .catch((err) => {
        warn("mind", `session "${name}": failed to initialise, a fresh thread will start:`, err);
        // Never tell the mind a tail was restored onto the empty thread that starts instead.
        session.seeded = false;
        session.seededRecollection = false;
      });
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

  async function initSession(session: CodexSession) {
    const isEphemeral = session.name.startsWith("new-");
    log("mind", `session "${session.name}": ${isEphemeral ? "ephemeral" : "persistent"}`);
    emit(session, { type: "session_start" });

    if (!isEphemeral) {
      const stored = sessionStore.load(session.name);
      let resumeThreadId = stored?.threadId;
      // A committed thread whose rollout codex can't read — the one this session would
      // otherwise be waking into, and what it lost if nothing can bring it back.
      let lostThreadId: string | undefined;
      // `resumeThread` never throws — it only builds an object — so a pointer to a rollout
      // codex can't find has to be caught here, or it fails every turn on this thread.
      if (resumeThreadId && !rolloutVisibleToCodex(resumeThreadId)) {
        log(
          "mind",
          `session "${session.name}": stored thread ${resumeThreadId} not found by codex`,
        );
        sessionStore.delete(session.name);
        if (lostRealContext(stored)) {
          lostThreadId = resumeThreadId;
        } else {
          // Stamped at thread.started, but no turn ever completed in it — nothing to lose,
          // and saying otherwise on an ordinary restart would be a lie (#769).
          log("mind", `session "${session.name}": pointer never carried a turn — nothing was lost`);
        }
        resumeThreadId = undefined;
      } else if (stored && resumeThreadId) {
        session.committed = stored.committed;
      }

      // An import that didn't bring a committed thread's rollout along archived its pointer
      // rather than let it resume a thread that isn't this mind's, and marked it: the mind
      // is owed the same account of that thread as of any other it lost (#1194).
      if (!resumeThreadId && !lostThreadId) {
        const archived = findLatestArchivedThread(sessionsDir, session.name);
        if (archived?.rolloutLeftBehind) {
          log(
            "mind",
            `session "${session.name}": thread ${archived.threadId} left behind on import`,
          );
          clearRolloutLeftBehind(archived);
          lostThreadId = archived.threadId;
        }
      }

      // The lost rollout may still exist in the root codex used to read — a provider switch
      // moves CODEX_HOME. Then this thread's own tail can be carried to where codex looks
      // now: the same conversation, restored the way any restart restores it.
      if (lostThreadId && findCodexSessionFile(lostThreadId, options.mindDir)) {
        const carried = await rotateCodexSession({
          mindDir: options.mindDir,
          name: session.name,
          oldThreadId: lostThreadId,
          ...seam(),
        });
        if (carried) {
          log(
            "mind",
            `session "${session.name}": carried ${lostThreadId} to codex's root as ${carried.threadId}`,
          );
          resumeThreadId = carried.threadId;
          armSeeded(session, carried.threadId, null, carried.recallEntries);
          lostThreadId = undefined;
        }
      }

      if (!resumeThreadId) {
        // Fresh persistent session — seed it from the previous session's archived
        // rollout so the mind experiences the conversation continuing rather than
        // waking into an empty context.
        const seeded = await seedCodexSession({
          mindDir: options.mindDir,
          name: session.name,
          ...seam(),
        });
        if (seeded) {
          resumeThreadId = seeded.threadId;
          armSeeded(session, seeded.threadId, seeded.archivedAt, seeded.recallEntries);
          log("mind", `session "${session.name}": seeded from previous transcript`);
        }
        if (lostThreadId) {
          // The live thread is gone. If an older archive stood in for it, say how old, so
          // the "restored" note on that tail and this notice tell one story, not two.
          const gap = seeded?.archivedAt != null ? formatGap(Date.now() - seeded.archivedAt) : null;
          const standIn = !seeded
            ? ""
            : ` What you see in it now is an older session${gap ? `, archived ${gap} ago` : ""}` +
              " — everything after that is lost.";
          noticeContextLost(
            session.name,
            `The previous session for ${threadRef(session.name)} couldn't be restored ` +
              `(its codex rollout is missing), so it was reset.${standIn} ` +
              "`volute mind history` has the record of what you were doing.",
          );
        }
      }
      if (resumeThreadId) {
        log("mind", `session "${session.name}": resuming thread ${resumeThreadId}`);
        session.thread = codexFor(session).resumeThread(resumeThreadId, threadOptions());
        session.currentThreadId = resumeThreadId;
        // A seeded thread is new to this session; a stored one is resumed.
        session.startupSource = session.seeded ? "startup" : "resume";
        return;
      }
    }

    startFreshThread(session);
  }

  /**
   * Arm a session to resume a seeded thread: the boundary note for its first turn, and a
   * committed pointer — the tail is real content from the start. Stamped now, as claude
   * does, not at the first turn's thread.started, or a restart before that turn would seed
   * again from the same source.
   */
  function armSeeded(
    session: CodexSession,
    threadId: string,
    archivedAt: number | null,
    recallEntries: number,
  ) {
    session.seeded = true;
    session.seededArchivedAt = archivedAt;
    session.seededCause = "restored";
    session.seededRecollection = recallEntries > 0;
    session.committed = true;
    sessionStore.save(session.name, threadId, true);
  }

  function startFreshThread(session: CodexSession) {
    // A fresh thread knows nothing of the orientation the old one was given.
    session.startupSource = "startup";
    session.thread = null;
    session.currentThreadId = null;
    session.committed = false;
    session.seeded = false;
    session.lastUsage = ZERO_USAGE;
    session.contextTokens = 0;
    newModelContext(session);
    try {
      session.thread = codexFor(session).startThread(threadOptions());
      log("mind", `session "${session.name}": new thread started`);
    } catch (err) {
      warn("mind", `session "${session.name}": failed to start thread:`, err);
    }
  }

  // --- Event broadcasting ---

  /** To this session's listeners, tagged with the current message unless the event names one. */
  function broadcast(session: CodexSession, event: VoluteEvent) {
    const tagged =
      event.messageId === undefined && session.currentMessageId != null
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

  // --- Turn execution ---

  /**
   * Tell the daemon this turn failed, so it records a `turn_error` notice for the mind's
   * next turn, flags the failure on the dashboard, and holds back the notices drained into
   * this turn's prompt rather than marking them delivered. Awaited before `done`, which is
   * what the daemon reads that last decision off.
   */
  async function emitError(session: CodexSession, message: string) {
    await emit(session, { type: "error", content: message });
  }

  /**
   * One `done` for the daemon, as claude sends, and one for each message the turn absorbed.
   * The daemon's names the turn by the message that led it and covers every one absorbed,
   * so the daemon knows they are all finished (#1207).
   */
  function emitDone(session: CodexSession, messageIds: string[]) {
    for (const messageId of messageIds) broadcast(session, { type: "done", messageId });
    session.currentMessageId = messageIds[0]; // emit() reads the channel from it
    emit(session, { type: "done", covers: messageIds });
  }

  /**
   * Commit what changed under home/ and in the pages worktree, which the mind's own repo
   * ignores — see lib/home-changes.ts for why git is asked rather than the turn's items.
   */
  async function commitHomeChanges() {
    try {
      for (const dir of [options.cwd, resolvePath(options.cwd, "pages/_system")]) {
        for (const path of await changedPaths(dir)) trackFileChange(path, options.cwd);
      }
      await flushFileChanges(options.cwd);
    } catch (err) {
      warn("mind", "auto-commit failed:", err);
    }
  }

  /**
   * Sessions of this mind currently inside a turn. Git sees the whole of home/, not whose
   * edit is whose, so a turn that ends while another is mid-write would commit that one's
   * half-written file. Only the last turn to end commits; it gathers everyone's work.
   */
  let turnsInFlight = 0;

  /**
   * The next run's messages, taken off the queue: the one at its head, and every other
   * queued message for the same channel. A run answers one channel, so its replies, its
   * reply instructions and its event note are all about that channel; a system event is
   * never folded with anything, since nothing awaits a reply to it. Everything else stays
   * queued for the next run of the same turn.
   */
  function nextBatch(queue: QueuedMessage[]): QueuedMessage[] {
    const isEvent = (m: QueuedMessage) => !!m.meta.isEvent || isEventChannel(m.meta.channel);
    const head = queue[0];
    const joins = (m: QueuedMessage) =>
      m === head || (!isEvent(head) && !isEvent(m) && m.meta.channel === head.meta.channel);
    const batch = queue.filter(joins);
    const rest = queue.filter((m) => !joins(m));
    queue.splice(0, queue.length, ...rest);
    return batch;
  }

  /**
   * Run one turn: the message at the head of the queue, and whatever else is queued or
   * arrives while it runs, with a single `done` at the end (#1200).
   *
   * The daemon holds the mind's turn slot from a delivery until that `done`, and delivers a
   * message for the thread already mid-turn straight in, trusting it to join that turn —
   * claude folds it into the running SDK stream. `codex exec` takes its whole input up front
   * (the SDK writes stdin and closes it), so a run can't be joined once started. The next
   * best thing keeps the promise the slot makes: queued messages for one channel go into one
   * run, and everything else — another channel, a system event, anything arriving during a
   * run — into further runs of the same turn, so no `done` releases the slot while this
   * thread still has work. That is the overlap with another thread #939 exists to prevent.
   *
   * The last queue check and the `done` have no await between them: a message that lands
   * after it is a fresh delivery, which takes its own slot. And the `done` is sent however
   * the turn ends — a lost one would hold the slot and leave this thread queueing forever.
   */
  async function runTurn(session: CodexSession) {
    const absorbed: string[] = [];
    try {
      do {
        turnsInFlight++;
        try {
          while (session.messageQueue.length > 0) {
            // Between runs of one turn — the context the last run left is what the next reads.
            if (absorbed.length > 0) await maybeRotate(session);
            const batch = nextBatch(session.messageQueue);
            for (const m of batch) absorbed.push(m.meta.messageId);
            session.currentMessageId = batch[0].meta.messageId;
            await runTurnBody(session, batch);
          }
        } finally {
          turnsInFlight--;
        }
        // Commit even after a failed turn: whatever it wrote to disk is still the mind's work.
        if (turnsInFlight === 0) await commitHomeChanges();
      } while (session.messageQueue.length > 0);
    } catch (err) {
      warn("mind", `session "${session.name}": turn broke:`, err);
      await emitError(session, `The turn stopped on an internal error: ${String(err)}`);
    } finally {
      emitTurnUsage(session);
      emitDone(session, absorbed);
      for (const id of absorbed) session.messageChannels.delete(id);
      session.currentMessageId = undefined;
    }
  }

  /** One `codex exec` run over a batch of queued messages. */
  async function runTurnBody(session: CodexSession, batch: QueuedMessage[]) {
    // Each message already carries its own channel/sender prefix from the router.
    let text = batch.map((m) => m.text).join("\n\n");
    const images = batch.flatMap((m) => m.images);
    // A thread that failed to start is tried again for each message, not left wedged.
    if (!session.thread) startFreshThread(session);
    if (!session.thread) {
      warn("mind", `session "${session.name}": no thread, dropping message`);
      await emitError(
        session,
        "Codex could not start a thread for this session, so the message was not processed.",
      );
      return;
    }

    // Refresh system prompt before each turn — this is how an identity edit takes effect.
    // The SDK spawns a fresh `codex exec` per run (codex-sdk 0.145 `exec.run`), passing
    // model_instructions_file as a --config override each time, so the next turn is handed
    // the edit; a restart would only repeat that same resume. (Unverified here: that Codex
    // prefers the override to the base_instructions a resumed rollout's session_meta
    // carries.) Deferring to a session boundary as the claude template does isn't possible:
    // the file is shared by every thread.
    refreshSystemPrompt();

    // The message as it arrived, before any context is prepended — what pre-prompt hooks
    // (e.g. resonance's per-turn recall) read as `prompt`.
    const prompt = text;

    // Whether this turn's prompt carries the startup context — a retry on a fresh thread
    // (below) must carry it too, but not twice. Started now and awaited alongside the
    // pre-prompt hooks below, so the two hook spawns don't queue behind each other.
    const carriesStartupContext = session.startupSource !== null;
    const orientation = takeStartupContext(session);

    // On the first turn of a seeded session, prepend the honest-boundary note
    // (consumed once) so the mind knows the tail above was restored (restart) or
    // rotated (context limit). The restored note carries a coarse gap-duration
    // clause when the archive time is known; the rotation note has no gap clause.
    let note: string | undefined;
    if (session.seeded) {
      session.seeded = false;
      note = buildSeededNote({
        cause: session.seededCause,
        archivedAtMs: session.seededArchivedAt,
        recollection: session.seededRecollection,
      });
      emit(session, {
        type: "context",
        content: note,
        metadata: { source: "seeded-session" },
      });
    }

    const [startupContext, hookResult] = await Promise.all([
      orientation,
      runHooks(hooksDir, "pre-prompt", {
        event: "pre-prompt",
        session: session.name,
        // The delivery this run answers, so the notices it drains are its turn's.
        messageId: session.currentMessageId,
        prompt,
      }).catch((err) => {
        warn("mind", "pre-prompt hook failed:", err);
        return null;
      }),
    ]);
    if (startupContext) text = `${startupContext}\n\n${text}`;
    if (note) text = `${note}\n\n${text}`;
    if (hookResult?.additionalContext) {
      emit(session, {
        type: "context",
        content: hookResult.additionalContext,
        metadata: { source: "dynamic:pre-prompt", ...hookResult.metadata },
      });
      text = `${hookResult.additionalContext}\n\n${text}`;
    }

    // Either the system-event note or reply instructions — never both, and never reply
    // instructions on an event turn. See turn-context.ts for the rule and why it matters.
    const turnContext = turnContextFor(
      batch.map((m) => m.meta),
      session,
      prompts,
    );
    if (turnContext) {
      emit(session, {
        type: "context",
        content: turnContext.content,
        metadata: { source: turnContext.source },
      });
      text = `${turnContext.content}\n\n${text}`;
    }

    // Codex takes images only as files (`--image`), so each one lives on disk for exactly
    // this turn. An image that can't be passed through is named in the prompt instead of
    // dropped without a word.
    const written = images.length
      ? writeImages(images, resolvePath(options.mindDir, ".mind/tmp/images"))
      : { paths: [], failed: 0 };
    if (written.failed > 0) {
      const n = written.failed;
      text = `[${n} image${n === 1 ? " was" : "s were"} attached to this message but couldn't be passed through to you.]\n\n${text}`;
    }
    const input: Input = written.paths.length
      ? [
          { type: "text", text },
          ...written.paths.map((path) => ({ type: "local_image" as const, path })),
        ]
      : text;

    try {
      let failure = await streamTurn(session, input);

      // A failed turn on a thread whose rollout codex can no longer see will fail the same
      // way on every later turn, so drop it rather than leave the thread wedged. If it held
      // real conversation, that's a loss, and this message gets one try on the fresh thread
      // — told, in the retry itself, that the thread was reset, so the mind never answers
      // on an empty thread believing it continuous. If it never held any — typically a
      // brand-new thread whose first turn failed before codex wrote anything — nothing was
      // lost, and a retry would only repeat whatever failed.
      //
      // Codex can also refuse a rollout that is right there: its thread index names the
      // file by an absolute path, and when that path is stale it says so instead of looking
      // in its own sessions dir (#1194) — a mind imported before the import dropped that
      // index. Same wedge, but the conversation isn't lost: its tail is carried onto a
      // fresh thread, as a restart carries one, and the message retried there.
      const lostThreadId = session.currentThreadId;
      if (
        failure &&
        lostThreadId &&
        (!rolloutVisibleToCodex(lostThreadId) ||
          failure.includes(`no rollout found for thread id ${lostThreadId}`))
      ) {
        const lostContext = session.committed;
        const persistent = !session.name.startsWith("new-");
        log(
          "mind",
          `session "${session.name}": thread ${lostThreadId} has no rollout codex can resume — starting fresh`,
        );
        if (persistent) sessionStore.delete(session.name);
        // Either way the retry runs on a thread with a new context, re-sending this turn's
        // prompt — reply instructions and all, if it had them — so once it has run, that
        // context has been given them (#1226).
        const retry = async (prefix: string) => {
          const failed = await streamTurn(session, prependText(input, prefix));
          if (!failed && turnContext?.source === "reply-instructions") {
            session.replyInstructionsFired = true;
          }
          return failed;
        };
        const carried =
          lostContext && persistent && findCodexSessionFile(lostThreadId, options.mindDir)
            ? await rotateCodexSession({
                mindDir: options.mindDir,
                name: session.name,
                oldThreadId: lostThreadId,
                ...seam(),
              })
            : null;
        if (carried) {
          log(
            "mind",
            `session "${session.name}": carried ${lostThreadId} onto ${carried.threadId}`,
          );
          session.thread = codexFor(session).resumeThread(carried.threadId, threadOptions());
          session.currentThreadId = carried.threadId;
          session.contextTokens = 0;
          session.lastUsage = ZERO_USAGE;
          armSeeded(session, carried.threadId, null, carried.recallEntries);
          newModelContext(session);
          // This turn's boundary note has been taken already, so the retry carries it.
          session.seeded = false;
          const note = buildSeededNote({
            cause: session.seededCause,
            archivedAtMs: null,
            recollection: session.seededRecollection,
          });
          emit(session, { type: "context", content: note, metadata: { source: "seeded-session" } });
          failure = await retry(note);
        } else {
          startFreshThread(session);
        }
        if (lostContext && !carried) {
          const lost =
            `${threadRef(session.name)} couldn't be resumed (codex couldn't find its rollout), ` +
            "so it started fresh — the conversation before the reset was lost. " +
            "`volute mind history` has the record of what you were doing.";
          if (session.thread) {
            emit(session, { type: "context", content: lost, metadata: { source: "context-lost" } });
            if (carriesStartupContext) session.startupSource = null;
            const retryContext = await takeStartupContext(session);
            const retryText = retryContext ? `${retryContext}\n\n${lost}` : lost;
            failure = await retry(retryText);
          }
          // The retry carried the news itself; a notice is only needed when the mind hasn't
          // heard it — no retry, or one that failed too.
          if (failure || !session.thread) await noticeContextLost(session.name, lost);
        }
      }

      if (failure) await emitError(session, failure);
    } finally {
      for (const path of written.paths) rmSync(path, { force: true });
    }
  }

  /**
   * The startup context owed to the first turn of a thread — run at that turn, for this
   * session and why its thread started, so it is current (#1199). Null when it's owed none.
   */
  async function takeStartupContext(session: CodexSession): Promise<string | null> {
    const source = session.startupSource;
    if (!source) return null;
    session.startupSource = null;
    const startupContext = await getStartupContext({ session: session.name, source });
    if (startupContext) {
      emit(session, {
        type: "context",
        content: startupContext,
        metadata: { source: "startup-context" },
      });
    }
    return startupContext;
  }

  /**
   * Run the mind's `post-tool-use` hooks for one completed tool call. The stdin is claude's
   * PostToolUse shape, with codex's items mapped onto claude's tool names (see
   * {@link postToolUseCalls}), so one hook works under every template (#1199). As on claude,
   * what a hook prints is recorded as context for the dashboard, not handed to the model —
   * codex runs the whole turn inside `codex exec`, so there is nothing to hand it to.
   */
  async function runPostToolUse(session: CodexSession, call: ToolCall) {
    try {
      const threadId = session.currentThreadId;
      const result = await runHooks(hooksDir, "post-tool-use", {
        hook_event_name: "PostToolUse",
        session: session.name,
        session_id: threadId ?? undefined,
        transcript_path: (threadId && rolloutPathFor(threadId)) || undefined,
        cwd: options.cwd,
        ...call,
      });
      if (result.additionalContext || Object.keys(result.metadata).length > 0) {
        emit(session, {
          type: "context",
          content: result.additionalContext,
          metadata: { source: "dynamic:post-tool-use", ...result.metadata },
        });
      }
    } catch (err) {
      warn("mind", "post-tool-use hook failed:", err);
    }
  }

  /**
   * Run one turn on the session's thread and forward its events. Returns why the turn
   * failed, or null when it completed (or was interrupted — an abort isn't a failure).
   */
  async function streamTurn(session: CodexSession, input: Input): Promise<string | null> {
    try {
      return await streamRun(session, input);
    } finally {
      // A subagent outliving the run that called it has no one left to answer.
      for (const run of session.subagentRuns) run.abort();
    }
  }

  async function streamRun(session: CodexSession, input: Input): Promise<string | null> {
    const thread = session.thread;
    if (!thread) return "no codex thread";
    session.abortController = new AbortController();

    // A turn can fail three ways, and one failure can arrive as more than one of them:
    // `turn.failed` is yielded, then the exec's non-zero exit throws from the stream.
    let turnFailed: string | null = null;
    let streamError: string | null = null;
    let thrown: string | null = null;
    let completed = false;
    // Post-tool-use hooks run one after another, in the order the tools completed, and the
    // turn isn't over until they are — their context belongs to this turn, before `done`.
    // Only when the mind has any: most don't, and then there is nothing to spawn.
    // An interrupted turn doesn't wait on them: hooks not yet started are skipped, and one
    // already running finishes on its own.
    const toolHooks = discoverHooks(hooksDir, "post-tool-use").length > 0;
    const { signal } = session.abortController;
    let toolHooksDone = Promise.resolve();
    const afterTool = (item: ThreadItem) => {
      if (!toolHooks) return;
      for (const call of postToolUseCalls(item, options.cwd)) {
        toolHooksDone = toolHooksDone.then(() =>
          signal.aborted ? undefined : runPostToolUse(session, call),
        );
      }
    };

    try {
      const { events } = await thread.runStreamed(input, {
        signal: session.abortController.signal,
      });

      // Track text per item for streaming deltas
      const itemText = new Map<string, string>();

      for await (const event of events) {
        try {
          switch (event.type) {
            case "thread.started": {
              // Track the live thread id in-memory (used by rotation) and persist it for
              // resume — persistent sessions only; ephemeral `new-*` keep no pointer.
              // `committed` is carried, never reset: a resumed thread restates its id.
              session.currentThreadId = event.thread_id;
              if (!session.name.startsWith("new-")) {
                sessionStore.save(session.name, event.thread_id, session.committed);
                log("mind", `session "${session.name}": saved thread ${event.thread_id}`);
              }
              break;
            }

            case "item.started": {
              const item = event.item;
              // Stable per-item id so a tool_result links to its own tool_use (see
              // item.completed). Codex reuses this id across the item's start/end events.
              const itemId = item.id;

              if (item.type === "agent_message") {
                itemText.set(item.id, "");
              } else if (item.type === "reasoning") {
                // Reasoning text may arrive on started or completed
                if (item.text) emit(session, { type: "thinking", content: item.text });
              } else if (item.type === "command_execution") {
                emit(session, {
                  type: "tool_use",
                  content: JSON.stringify({ command: item.command }),
                  metadata: { name: "command", id: itemId },
                });
                broadcast(session, {
                  type: "tool_use",
                  name: "command",
                  input: { command: item.command },
                });
              } else if (item.type === "file_change") {
                const paths = item.changes.map((c) => c.path);
                emit(session, {
                  type: "tool_use",
                  content: JSON.stringify({ paths }),
                  metadata: { name: "file_change", id: itemId },
                });
                broadcast(session, {
                  type: "tool_use",
                  name: "file_change",
                  input: { paths },
                });
              } else if (item.type === "mcp_tool_call") {
                const toolName = `mcp:${item.server}/${item.tool}`;
                emit(session, {
                  type: "tool_use",
                  content: JSON.stringify(item.arguments ?? {}),
                  metadata: { name: toolName, id: itemId },
                });
                broadcast(session, {
                  type: "tool_use",
                  name: toolName,
                  input: item.arguments ?? {},
                });
              } else if (item.type === "web_search") {
                emit(session, {
                  type: "tool_use",
                  content: JSON.stringify({ query: item.query }),
                  metadata: { name: "web_search", id: itemId },
                });
                broadcast(session, {
                  type: "tool_use",
                  name: "web_search",
                  input: { query: item.query },
                });
              }
              break;
            }

            case "item.updated": {
              const item = event.item;
              if (item.type === "agent_message") {
                const prev = itemText.get(item.id) ?? "";
                const full = item.text;
                if (full.length > prev.length) {
                  const delta = full.slice(prev.length);
                  itemText.set(item.id, full);
                  broadcast(session, { type: "text", content: delta });
                  emit(session, { type: "text", content: delta });
                }
              }
              break;
            }

            case "item.completed": {
              const item = event.item;
              // Same id emitted on item.started, so the daemon links this result to its tool_use.
              const itemId = item.id;

              if (item.type === "reasoning") {
                if (item.text) emit(session, { type: "thinking", content: item.text });
              } else if (item.type === "agent_message") {
                // Emit any remaining delta
                const prev = itemText.get(item.id) ?? "";
                const full = item.text;
                if (full.length > prev.length) {
                  const delta = full.slice(prev.length);
                  broadcast(session, { type: "text", content: delta });
                  emit(session, { type: "text", content: delta });
                }
                itemText.delete(item.id);
              } else if (item.type === "command_execution") {
                const output = item.aggregated_output;
                const isError = item.status === "failed" || (item.exit_code ?? 0) !== 0;
                emit(session, {
                  type: "tool_result",
                  content: output,
                  metadata: { name: "command", is_error: isError, tool_use_id: itemId },
                });
                broadcast(session, { type: "tool_result", output, is_error: isError });
              } else if (item.type === "file_change") {
                // Tracked for the pages worktree, which the turn-end git status of the
                // mind's own repo can't see; everything else it would catch anyway.
                for (const change of item.changes) trackFileChange(change.path, options.cwd);
                const output = item.changes.map((c) => `${c.kind}: ${c.path}`).join("\n");
                const isError = item.status === "failed";
                emit(session, {
                  type: "tool_result",
                  content: output,
                  metadata: { name: "file_change", is_error: isError, tool_use_id: itemId },
                });
                broadcast(session, { type: "tool_result", output, is_error: isError });
              } else if (item.type === "mcp_tool_call") {
                const isError = item.status === "failed" || item.error !== undefined;
                const output = item.error ? item.error.message : mcpResultText(item.result);
                emit(session, {
                  type: "tool_result",
                  content: output,
                  metadata: {
                    name: `mcp:${item.server}/${item.tool}`,
                    is_error: isError,
                    tool_use_id: itemId,
                  },
                });
                broadcast(session, { type: "tool_result", output, is_error: isError });
              } else if (item.type === "web_search") {
                emit(session, {
                  type: "tool_result",
                  content: "search completed",
                  metadata: { name: "web_search", tool_use_id: itemId },
                });
                broadcast(session, { type: "tool_result", output: "search completed" });
              }
              afterTool(item);
              break;
            }

            case "turn.completed": {
              completed = true;
              // The thread now holds a completed exchange — losing it from here on is a
              // real loss (see SessionRecord.committed).
              if (!session.committed) {
                session.committed = true;
                if (session.currentThreadId && !session.name.startsWith("new-")) {
                  sessionStore.save(session.name, session.currentThreadId, true);
                }
              }
              // codex's usage is cumulative over the whole thread — the per-turn cost is
              // the difference from the last snapshot (see lib/usage.ts).
              const delta = usageDelta(session.lastUsage, event.usage);
              if (delta) {
                session.lastUsage = delta.next;
                // The turn's own context size, not the thread's running total. Feeds
                // the dashboard's fallback estimate only; rotation measures the
                // rollout itself (see measureContext).
                session.contextTokens = delta.contextTokens;
                // Reported once, for the whole turn, at its end (see emitTurnUsage).
                session.turnUsage.push(delta.payload);
              }
              break;
            }

            case "turn.failed": {
              turnFailed = event.error.message;
              break;
            }

            case "error": {
              // codex-rs emits this for errors it may still retry past, so it only counts
              // as a failure when the turn never completes.
              streamError = event.message;
              break;
            }
          }
        } catch (err) {
          warn("mind", `session "${session.name}": event handler error (${event.type}):`, err);
        }
      }
    } catch (err: any) {
      if (err?.name === "AbortError") {
        log("mind", `session "${session.name}": turn aborted`);
        return null;
      }
      thrown = err instanceof Error ? err.message : String(err);
    }
    await toolHooksDone;

    const failure =
      turnFailed ??
      thrown ??
      (completed ? null : (streamError ?? "The turn ended before codex reported it complete."));
    if (failure) warn("mind", `session "${session.name}": turn failed: ${failure}`);
    else log("mind", `session "${session.name}": turn done`);
    return failure;
  }

  // --- Rotation (silent, at turn end) ---

  /**
   * Rotate the thread in place: build a seeded budget-tail rollout out of the live
   * rollout, archive the rotated-out thread, and resume the new thread. On any failure
   * we leave the old thread in place and let the SDK's native backstop handle it if
   * context keeps climbing.
   */
  async function performRotation(session: CodexSession) {
    const oldThreadId = session.currentThreadId;

    // Awaited between turns, inside the queue loop, so the session stays quiet while
    // recollection loads: nothing is appended to the rollout this seed was read from.
    const rotated = oldThreadId
      ? await rotateCodexSession({
          mindDir: options.mindDir,
          name: session.name,
          oldThreadId,
          ...seam(),
        })
      : null;
    const newThreadId = rotated?.threadId;
    if (!newThreadId) {
      log("mind", `session "${session.name}": rotation failed, deferring to SDK backstop`);
      return;
    }

    try {
      session.thread = codexFor(session).resumeThread(newThreadId, threadOptions());
    } catch (err) {
      warn("mind", `session "${session.name}": failed to resume rotated thread:`, err);
      return; // keep the old thread; the SDK backstop covers a runaway
    }
    session.currentThreadId = newThreadId;
    // The rotated rollout carries the verbatim tail — real content from the first stamp.
    session.committed = true;
    if (!session.name.startsWith("new-")) sessionStore.save(session.name, newThreadId, true);
    // Fresh thread — reset token tracking (the next turn.completed sets the real value)
    // and arm the rotation-cause boundary note for the mind's next turn.
    session.contextTokens = 0;
    session.lastUsage = ZERO_USAGE;
    session.seeded = true;
    session.seededCause = "rotation";
    session.seededArchivedAt = null;
    session.seededRecollection = (rotated?.recallEntries ?? 0) > 0;
    session.startupSource = "compact";
    newModelContext(session);
    // Spend a slot. Recorded only here, after the rotation actually landed — a failed
    // attempt must not count against the streak.
    recordRotation(session.rotationGuard);
    if (budgetSpent(session.rotationGuard)) {
      log(
        "mind",
        `session "${session.name}": ${MAX_CONSECUTIVE_ROTATIONS} rotations without relief — deferring further compaction to the SDK (system prompt likely too large)`,
      );
    }
    log("mind", `session "${session.name}": rotated to ${newThreadId}`);
  }

  /**
   * The context the model was last sent, or null when it can't be measured.
   *
   * Reads the rollout's own `last_token_usage.input_tokens` — codex-rs records the exact
   * size of the most recent request, which is precisely what the threshold is asking
   * about. Null means the rollout isn't readable yet: no thread id, or a freshly seeded
   * thread codex hasn't written a `token_count` into. `shouldRotate` declines to rotate
   * on a null rather than falling back to the turn's input delta, which sums every
   * request in the turn and so reads several times high on a tool loop.
   */
  async function measureContext(session: CodexSession): Promise<number | null> {
    const threadId = session.currentThreadId ?? sessionStore.load(session.name)?.threadId;
    if (!threadId) return unmeasurable(session, "no thread id yet");
    let path: string | null;
    try {
      path = rolloutPathFor(threadId);
    } catch (err) {
      return unmeasurable(session, `rollout lookup failed for thread ${threadId}: ${err}`);
    }
    if (!path) return unmeasurable(session, `no rollout file found for thread ${threadId}`);
    try {
      const measured = await readLastContextTokens(path);
      return measured === null ? unmeasurable(session, `no token_count yet in ${path}`) : measured;
    } catch (err) {
      return unmeasurable(session, `could not read ${path}: ${err}`);
    }
  }

  /**
   * Note the first unmeasurable turn of a session, once, and return null.
   *
   * Without this the state is silent and indistinguishable from a healthy one: a null
   * never rotates, so a mind whose rollout can never be located — a CODEX_HOME or HOME
   * mismatch under per-user isolation would do it — climbs quietly to the SDK's backstop
   * with nothing in the log to say why volute stopped rotating. The reason string
   * separates that from the benign case, a freshly seeded thread codex hasn't written a
   * `token_count` into yet, which resolves itself on the next turn.
   */
  function unmeasurable(session: CodexSession, reason: string): null {
    if (!session.measureWarned) {
      session.measureWarned = true;
      log(
        "mind",
        `session "${session.name}": context not measurable (${reason}) — not rotating; the SDK backstop covers a runaway. Logged once per session.`,
      );
    }
    return null;
  }

  /**
   * Decide, after a turn, whether to rotate in place: only when a threshold is
   * configured, the measured context is at/over it, and the streak of rotations that
   * relieved nothing is under the cap (past it, the SDK's native backstop takes over).
   * Rotation is silent — the one-line rotation note arms via seededCause and lands
   * on the next turn.
   *
   * Measures even when the streak is spent, deliberately: the streak only lifts on a
   * turn that measures under the threshold, so skipping the read to save the work would
   * make the cap permanent for the life of the session.
   */
  async function maybeRotate(session: CodexSession) {
    const contextTokens = maxContextTokens ? await measureContext(session) : null;
    if (!shouldRotate(session.rotationGuard, contextTokens, maxContextTokens)) return;
    log(
      "mind",
      `session "${session.name}": ${contextTokens} tokens >= ${maxContextTokens} — rotating`,
    );
    try {
      await performRotation(session);
    } catch (err) {
      // Leaves the old thread in place, as a rotation that can't proceed always does.
      warn("mind", `session "${session.name}": rotation failed:`, err);
    }
  }

  // --- Message queue processing ---

  async function processQueue(session: CodexSession) {
    if (session.processing) return;
    session.processing = true;
    try {
      await session.ready;
      while (session.messageQueue.length > 0) {
        await runTurn(session);
        // After the turn's `done` is between turns, so rotate here if we're over.
        await maybeRotate(session);
      }
    } finally {
      session.processing = false;
    }
    // An ephemeral `new-*` session never recurs, so once its queue drains nothing will
    // use it again — drop it and its client, or each one is held for the process's life.
    // Synchronous with the loop's exit, so no message can queue between the check and the
    // delete.
    if (session.name.startsWith("new-") && sessions.get(session.name) === session) {
      sessions.delete(session.name);
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
          session.messageChannels.set(meta.messageId, meta.channel);
        }

        const text = extractText(content);
        const images = extractImages(content);

        if (meta.interrupt && session.processing) {
          // Abort current turn and push interrupting message to front
          session.abortController?.abort();
          session.messageQueue.unshift({ text, images, meta });
        } else {
          session.messageQueue.push({ text, images, meta });
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

  const claudeMdTokens = countSdkInstructionTokens(options.cwd);
  const skillDescTokens = countSkillDescriptionTokens([resolvePath(options.cwd, ".agents/skills")]);

  function jsonlPathFor(sessionName: string): string | null {
    const threadId = sessionStore.load(sessionName)?.threadId;
    return threadId ? rolloutPathFor(threadId) : null;
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
                    countSystemPromptTokens(systemPrompt),
                    claudeMdTokens,
                    skillDescTokens,
                  )
                ).parsed,
            )
          : null;
        infos.push({
          name: s.name,
          // Display only, and deliberately not `measureContext`: a null `parsed` for a
          // persistent session means the same rollout carried no usage event, so a
          // second read of it could only return null too. The turn delta reads high on
          // a tool loop and can render past 100% of the window — an honest "we couldn't
          // measure, it's large" rather than a clamp that would look like a reading.
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
    return { sessions: infos, systemPrompt: countSystemPromptTokens(systemPrompt) };
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
              countSystemPromptTokens(systemPrompt),
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
        systemPrompt,
        sdkInstructions: readSdkInstructions(options.cwd),
        skillDescriptions: readSkillDescriptions([skillsDir]),
      },
      sessions: sessionMessages,
    };
  }

  // Pre-warm the main session so the thread is created immediately
  // instead of waiting for the first message.
  getOrCreateSession("main");

  return { resolve, getContextInfo, getContextMessages, flushFileChanges: commitHomeChanges };
}
