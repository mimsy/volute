import { type ChildProcess, execFile, type SpawnOptions, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { getAiConfig, resolveApiKey } from "../ai-service.js";
import { deliverEvent, recordNotice } from "../chat/system-events.js";
import { loadMergedEnv } from "../config/env.js";
import { getSystemName, readGlobalConfig } from "../config/setup.js";
import { chownMindDir, isIsolationEnabled, wrapForIsolation } from "../mind/isolation.js";
import {
  findMind,
  mindDir,
  mindTmpDir,
  mindTmpEnv,
  setMindRunning,
  stateDir,
  voluteSystemDir,
} from "../mind/registry.js";
import { isSandboxEnabled, wrapForSandbox } from "../mind/sandbox.js";
import { reapMindTmp } from "../mind/tmp-reaper.js";
import { getPrompt } from "../prompts.js";
import { checkHealth } from "../util/health.js";
import { clearJsonMap, loadJsonMap, saveJsonMap } from "../util/json-state.js";
import log from "../util/logger.js";
import { RotatingLog } from "../util/rotating-log.js";
import { markCredentialDegraded, noteCredentialHealthy } from "./credential-recovery.js";
import { injectPiProviderCredentials, writeClaudeCredentials } from "./credential-sync.js";
import { generateMindToken, revokeMindToken } from "./mind-tokens.js";
import {
  clearPendingContext,
  setPendingContext as persistPendingContext,
  readPendingContext,
} from "./pending-context.js";
import { RestartTracker } from "./restart-tracker.js";
import { DEFAULT_SPEND_PERIOD_MINUTES, getSpendBudget } from "./spend-budget.js";
import { clearMind as clearTurnState, summarizeOrphanedTurns } from "./turn-tracker.js";

const mlog = log.child("minds");

const execFileAsync = promisify(execFile);

// Benign system env vars a mind's node/tsx process needs to run. Everything else
// from the daemon environment (ambient AWS_*/GITHUB_TOKEN/etc.) is withheld.
const MIND_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TERM",
  "TERMINFO",
  "COLORTERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TZ",
  "NODE_ENV",
  "__CF_USER_TEXT_ENCODING",
  // Outbound proxy / custom-CA config — required for minds' HTTPS calls (incl.
  // the Anthropic API) to succeed on hosts that reach the internet only via a
  // corporate proxy or custom CA bundle. Previously inherited via ...process.env.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
];

/**
 * Build the base environment for a mind process from an allowlist instead of
 * spreading the full daemon `process.env`. Copies benign system vars plus all
 * `VOLUTE_*` vars the mind needs — but never the daemon admin token
 * (`VOLUTE_DAEMON_TOKEN`), which the caller replaces with a per-mind
 * `VOLUTE_MIND_TOKEN`.
 */
export function buildMindBaseEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const base: Record<string, string | undefined> = {};
  for (const key of MIND_ENV_ALLOWLIST) {
    if (source[key] !== undefined) base[key] = source[key];
  }
  for (const [key, value] of Object.entries(source)) {
    // Withhold the daemon admin token — minds get their own VOLUTE_MIND_TOKEN.
    if (key === "VOLUTE_DAEMON_TOKEN") continue;
    if (key.startsWith("VOLUTE_")) base[key] = value;
  }
  return base;
}

/**
 * The mind's own spend cap, as environment variables it can read.
 *
 * A mind currently meets its economics only as constraint — a notice at 80%, a
 * hold at 100%. These let it see the shape of the thing before it hits it, which
 * is the difference between a budget and a trapdoor: a mind that knows what it
 * has left can finish a thought, journal, or compact on purpose.
 *
 * With no cap set, both keys are explicitly `undefined` rather than omitted. The
 * spread lands after `loadMergedEnv()`, so omitting them would let a stale
 * `VOLUTE_SPEND_CAP` in the mind's or the shared `env.json` survive into the child
 * — and a mind must not be handed a limit that isn't there. An env var naming a
 * number nothing enforces is worse than silence.
 *
 * The period is always written alongside the amount, defaulted explicitly, so the
 * value is readable without knowing Volute's defaults.
 *
 * This is a snapshot taken at spawn: a cap changed mid-run leaves it stale, which
 * is why the startup line points at `volute usage` for the live figure.
 */
export function spendCapEnv(
  usage: { capUsd: number; periodMinutes: number } | null,
): Record<string, string | undefined> {
  if (!usage || usage.capUsd <= 0) {
    return { VOLUTE_SPEND_CAP: undefined, VOLUTE_SPEND_CAP_PERIOD_MINUTES: undefined };
  }
  return {
    VOLUTE_SPEND_CAP: String(usage.capUsd),
    VOLUTE_SPEND_CAP_PERIOD_MINUTES: String(usage.periodMinutes || DEFAULT_SPEND_PERIOD_MINUTES),
  };
}

/**
 * The live enforced cap for a mind, or null. Reads the running budget rather than
 * `volute.json` so a variant reports the cap that actually binds it (its parent's
 * bucket) instead of the copy of its parent's config sitting in its worktree.
 *
 * Tolerates an uninitialized budget — `getSpendBudget()` throws before
 * `initSpendBudget()`, and a mind starting without one simply has no cap to report.
 */
function readLiveSpendCap(baseName: string): { capUsd: number; periodMinutes: number } | null {
  try {
    return getSpendBudget().getUsage(baseName);
  } catch {
    return null;
  }
}

/**
 * The full environment a mind process is spawned with.
 *
 * Extracted from `_startMind` so the *wiring* is testable, not just the pieces.
 * The pieces each had coverage while the assembly had none — deleting the
 * spend-cap spread from an inline object literal broke no test, which is the
 * shape of #808: the daemon-side half of a capability goes missing and
 * everything still looks healthy.
 *
 * Order is load-bearing. `loadMergedEnv()` comes early so a mind's own env.json
 * cannot override the identity and cap the daemon assigns below it — a mind can
 * write its own env (`volute env set --mind`), and a `VOLUTE_SPEND_CAP` planted
 * there must not outrank the real one (or survive when there is none).
 */
export function composeMindEnv(opts: {
  name: string;
  baseName: string;
  dir: string;
  port: number;
  mindToken: string;
}): Record<string, string | undefined> {
  const { name, baseName, dir, port, mindToken } = opts;
  // Prepend mind's .local/bin to PATH for skill commands and volute wrapper
  const mindLocalBin = resolve(dir, "home", ".local", "bin");
  const currentPath = process.env.PATH ?? "";
  return {
    ...buildMindBaseEnv(),
    ...loadMergedEnv(name),
    VOLUTE_MIND: name,
    VOLUTE_STATE_DIR: stateDir(name),
    VOLUTE_MIND_DIR: dir,
    VOLUTE_MIND_PORT: String(port),
    VOLUTE_MIND_TOKEN: mindToken,
    // Left unset when the system has no configured name — the startup-context
    // hook then skips its "This system is named X" line rather than asserting
    // a fabricated one.
    VOLUTE_SYSTEM_NAME: readGlobalConfig().name,
    // The mind's own cap, keyed by baseName because that is the bucket a variant's
    // spend is recorded against (`handleMindEvent(baseName, …)`) and the one that
    // holds it. Both keys are cleared when no cap is configured.
    ...spendCapEnv(readLiveSpendCap(baseName)),
    ...mindTmpEnv(dir),
    PATH: `${mindLocalBin}:${currentPath}`,
    // Strip CLAUDECODE so the Agent SDK can spawn Claude Code subprocesses
    CLAUDECODE: undefined,
  };
}

type TrackedMind = {
  child: ChildProcess;
  port: number;
};

/**
 * Thrown when a mind process fails to become ready during startup. Carries the
 * child's recent stderr so callers (e.g. the restart route's last-known-good
 * recovery) can surface the actual failure to the mind.
 */
export class MindStartupError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "MindStartupError";
  }
}

/**
 * Thrown when a start is asked for after `stopAll()` has begun. Distinct from
 * MindStartupError: nothing is wrong with the mind, the daemon is simply on its
 * way out and will not supervise anything new.
 */
export class DaemonShuttingDownError extends Error {
  constructor(name: string) {
    super(`Cannot start mind ${name}: the daemon is shutting down`);
    this.name = "DaemonShuttingDownError";
  }
}

function mindPidPath(name: string): string {
  return resolve(stateDir(name), "mind.pid");
}

/**
 * Build the message a mind receives after a lifecycle event (restart, merge,
 * split, sprout, upgrade). The leading line comes from the prompt registry; the
 * optional Changes/Why/Context lines, a split's purpose, a merge's memory delta,
 * and a merge's farewell note are appended from the pending context. Pure and
 * exported so the stringly-typed context seam — where a mistyped key would
 * silently drop the variant's purpose, narrated memory, or parting note — is
 * testable without spawning a mind.
 */
/** Map a pending-context `type` to a lifecycle event subtype. */
function lifecycleSubtype(type: unknown): string {
  switch (type) {
    case "merge":
    case "merged":
      return "merge";
    case "split":
      return "split";
    case "sprouted":
      return "sprout";
    case "upgraded":
      return "upgrade";
    default:
      return "restart";
  }
}

export async function buildPendingContextMessage(
  name: string,
  context: Record<string, unknown>,
): Promise<string> {
  const parts: string[] = [];
  if (context.type === "merge" || context.type === "merged") {
    parts.push(await getPrompt("merge_message", { name: String(context.name ?? "") }));
  } else if (context.type === "split") {
    parts.push(await getPrompt("split_message", { name, parent: String(context.parent ?? "") }));
    if (context.purpose) parts.push(`Why you were split off: ${String(context.purpose)}`);
  } else if (context.type === "sprouted") {
    parts.push(await getPrompt("sprout_message", { system: getSystemName() }));
  } else if (context.type === "upgraded") {
    parts.push(await getPrompt("upgrade_message"));
  } else {
    parts.push(await getPrompt("restart_message"));
  }
  // An upgrade whose dependency install failed says so here, in the same message
  // that tells the mind it was upgraded — and only once the mind is actually up to
  // read it. Delivering it as its own event before the restart lost it: the POST
  // landed on the process about to be SIGTERMed, and marking it delivered took it
  // out of the pending set that start-up replay draws from (#973).
  if (context.depsFailure) parts.push(`\n${String(context.depsFailure)}`);
  if (context.summary) parts.push(`Changes: ${context.summary}`);
  if (context.justification) parts.push(`Why: ${context.justification}`);
  if (context.memory) parts.push(`Context: ${context.memory}`);
  if (context.memoryDelta) {
    parts.push(
      `\nYour variant's memory & journal (not merged — integrate into your own memory what you want to keep):\n${context.memoryDelta}`,
    );
  }
  // The variant's own voice from its farewell turn. Framed as continuity —
  // the merged mind is both lineages, not the parent absorbing a stranger.
  if (context.farewell)
    parts.push(`Your variant's parting note (this was you, winding down):\n${context.farewell}`);
  return parts.join("\n");
}

export class MindManager {
  private minds = new Map<string, TrackedMind>();
  private stopping = new Set<string>();
  private shuttingDown = false;
  private restartTracker = new RestartTracker();
  // Per-name lifecycle mutex: start/stop/restart for a given mind serialize so
  // concurrent callers can't double-spawn or have a loser's cleanup delete the
  // winner's tracked child.
  private locks = new Map<string, Promise<unknown>>();

  /** Run `fn` after any in-flight lifecycle op for `name` settles, serializing per name. */
  private withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(name) ?? Promise.resolve();
    const result = prev.then(fn, fn);
    // Keep a non-rejecting tail so later callers chain cleanly regardless of outcome.
    const tail = result.then(
      () => {},
      () => {},
    );
    this.locks.set(name, tail);
    tail.finally(() => {
      if (this.locks.get(name) === tail) this.locks.delete(name);
    });
    return result;
  }

  private async resolveTarget(name: string): Promise<{
    dir: string;
    port: number;
    baseName: string;
    template?: string;
  }> {
    const entry = await findMind(name);
    if (!entry) throw new Error(`Unknown mind: ${name}`);

    if (entry.parent) {
      // Variant — dir and port come from the minds table entry
      if (!entry.dir) throw new Error(`Variant ${name} has no directory`);
      return { dir: entry.dir, port: entry.port, baseName: entry.parent, template: entry.template };
    }

    const dir = entry.dir ?? mindDir(name);
    if (!existsSync(dir)) throw new Error(`Mind directory missing: ${dir}`);
    return { dir, port: entry.port, baseName: name, template: entry.template };
  }

  async startMind(name: string, opts?: { healthTimeoutMs?: number }): Promise<void> {
    return this.withLock(name, () => this._startMind(name, opts));
  }

  private async _startMind(name: string, opts?: { healthTimeoutMs?: number }): Promise<void> {
    // Nothing started now would be supervised, and stopAll() may already have
    // enumerated the set it is going to reap (#1048). Refuse before the spawn —
    // the second check, right after the child is registered below, catches the
    // narrower case where the flag goes up while this start is in flight.
    if (this.shuttingDown) throw new DaemonShuttingDownError(name);

    if (this.minds.has(name)) {
      throw new Error(`Mind ${name} is already running`);
    }

    const target = await this.resolveTarget(name);
    const { dir, baseName } = target;
    const port = target.port;

    // Kill any orphan process from a previous daemon session
    const pidFile = mindPidPath(name);
    try {
      if (existsSync(pidFile)) {
        const stalePid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
        if (stalePid > 0) {
          try {
            process.kill(stalePid, 0); // check if alive
            // Verify this is actually a mind process before killing the group
            const { stdout } = await execFileAsync("ps", ["-p", String(stalePid), "-o", "args="]);
            if (stdout.includes("server.ts")) {
              mlog.warn(`killing stale mind process ${stalePid} for ${name}`);
              process.kill(-stalePid, "SIGTERM");
              await new Promise((r) => setTimeout(r, 500));
            } else {
              mlog.debug(`stale PID ${stalePid} for ${name} is not a mind process, skipping`);
            }
          } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
              mlog.warn(`failed to check/kill stale process for ${name}`, log.errorData(err));
            }
          }
        }
        rmSync(pidFile, { force: true });
      }
    } catch (err) {
      mlog.warn(`failed to read PID file for ${name}`, log.errorData(err));
    }

    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        mlog.warn(`killing orphan process on port ${port}`);
        await killProcessOnPort(port);
        await new Promise((r) => setTimeout(r, 500));
      }
    } catch {
      // Port not in use — good
    }

    const mindStateDir = stateDir(name);
    const logsDir = resolve(mindStateDir, "logs");
    mkdirSync(logsDir, { recursive: true });

    // Per-mind tmp dir so minds never share a writable /tmp (a cross-mind channel).
    const mindTmp = mindTmpDir(dir);
    mkdirSync(mindTmp, { recursive: true });
    // A private /tmp needs a janitor, and nothing else clears this one: scratch a
    // killed process leaves here stays forever (#805). Spawn is the one moment we
    // know nothing of this mind's is running, so it is where the reap belongs.
    // Awaited, so the child never races the removal — and async, so clearing
    // gigabytes delays this one mind's start instead of stalling the daemon.
    await reapMindTmp(mindTmp);

    // State dir is created by root — chown so the mind user can write to it.
    // Chown .mind itself, not just .mind/tmp: in a variant worktree .mind is
    // absent (gitignored), so the recursive mkdir above creates it root-owned
    // and the variant can't write sessions or its farewell note (#653).
    if (isIsolationEnabled()) {
      try {
        await chownMindDir(mindStateDir, baseName);
        await chownMindDir(resolve(dir, ".mind"), baseName);
      } catch (err) {
        throw new Error(
          `Cannot start mind ${name}: failed to set ownership on state directory ${mindStateDir}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    const logStream = new RotatingLog(resolve(logsDir, "mind.log"));
    const mindToken = generateMindToken(name);
    const env = composeMindEnv({ name, baseName, dir, port, mindToken });

    // For pi minds, inject the system AI provider's API key
    if (target.template === "pi") {
      try {
        const configPath = resolve(dir, "home/.config/config.json");
        if (existsSync(configPath)) {
          const config = JSON.parse(readFileSync(configPath, "utf-8"));
          const modelStr = config.model as string | undefined;
          if (modelStr?.includes(":")) {
            const provider = modelStr.split(":")[0];
            const piAgentDir = resolve(dir, ".mind", "pi-agent");
            await injectPiProviderCredentials({
              provider,
              piAgentDir,
              baseName,
              mindName: name,
              env,
            });
          }
        }
      } catch (err) {
        mlog.error(`failed to inject AI provider key for ${name}`, log.errorData(err));
      }
    }

    // For codex minds, inject OpenAI credentials.
    // OAuth: write codex CLI auth.json so it can do its own token exchange.
    // API key: set OPENAI_API_KEY env var.
    if (target.template === "codex") {
      try {
        const ai = getAiConfig();
        const codexConfig = ai?.providers["openai-codex"];
        if (codexConfig?.oauth) {
          // Write credentials in the format the codex CLI expects (auth.json).
          // The codex CLI reads from CODEX_HOME/auth.json. We point CODEX_HOME to
          // a per-mind .codex dir so credentials don't collide with the host user's.
          const codexDir = resolve(dir, ".mind", "codex");
          mkdirSync(codexDir, { recursive: true });
          env.CODEX_HOME = codexDir;
          const authPath = resolve(codexDir, "auth.json");
          writeFileSync(
            authPath,
            JSON.stringify({
              auth_mode: "chatgpt",
              tokens: {
                access_token: codexConfig.oauth.access,
                refresh_token: codexConfig.oauth.refresh,
                id_token: codexConfig.oauth.access,
              },
              last_refresh: new Date().toISOString(),
            }),
            { mode: 0o600 },
          );
          // Ensure codex uses file-based credential storage
          const configTomlPath = resolve(codexDir, "config.toml");
          if (!existsSync(configTomlPath)) {
            writeFileSync(configTomlPath, 'cli_auth_credentials_store = "file"\n');
          }
          if (isIsolationEnabled()) {
            await chownMindDir(codexDir, baseName);
          }
        } else {
          const apiKey = await resolveApiKey("openai-codex");
          if (apiKey) {
            env.OPENAI_API_KEY = apiKey;
          } else if (process.env.OPENAI_API_KEY) {
            env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
          }
        }
      } catch (err) {
        mlog.error(`failed to resolve OpenAI API key for ${name}`, log.errorData(err));
        if (process.env.OPENAI_API_KEY) {
          env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
        }
      }

      // Write .zshenv in the mind's home dir — the codex sandbox runs commands in
      // /bin/zsh -lc which resets the environment. ZDOTDIR is set via codex config
      // so the login shell sources this file to restore VOLUTE vars and PATH.
      const homeDir = resolve(dir, "home");
      const zshenvLines = Object.entries(env)
        .filter(([k, v]) => k.startsWith("VOLUTE_") && v != null)
        .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`);
      zshenvLines.push(`export PATH=${JSON.stringify(env.PATH ?? "")}`);
      writeFileSync(resolve(homeDir, ".zshenv"), `${zshenvLines.join("\n")}\n`, { mode: 0o600 });
    }

    // For claude minds, inject system Anthropic credentials.
    // OAuth: write Claude Code credential file (~/.claude/.credentials.json) so the
    // Agent SDK authenticates natively. API key: set ANTHROPIC_API_KEY env var.
    if (target.template === "claude" || !target.template) {
      try {
        const ai = getAiConfig();
        const anthropicConfig = ai?.providers.anthropic;
        if (anthropicConfig?.oauth) {
          // Resolve once (refreshes + persists the rotated token to config if
          // needed), then write the current credentials from config so the
          // access/refresh/expires are consistent. We point CLAUDE_CONFIG_DIR to
          // the mind's .claude dir so credentials are per-mind. The daemon keeps
          // this file fresh (credential-sync) so the SDK never refreshes the
          // rotating grant itself.
          const key = await resolveApiKey("anthropic");
          const oauth = getAiConfig()?.providers.anthropic?.oauth;
          if (key && oauth) {
            const claudeDir = await writeClaudeCredentials(resolve(dir, "home"), baseName, oauth);
            env.CLAUDE_CONFIG_DIR = claudeDir;
            await noteCredentialHealthy(name);
          } else {
            // OAuth is configured but resolveApiKey couldn't derive a token and
            // there's no static-key/env fallback — a transient refresh/auth-server
            // failure. The mind spawns credential-less and with no CLAUDE_CONFIG_DIR
            // in its env, so a later fan-out write to that file isn't reliably picked
            // up — a restart, which rebuilds the env, is the repair that works.
            // Hand it to the recovery loop: it records the one-per-outage notice
            // (#701), alerts the host, and restarts the mind itself once a token
            // comes back — previously it just stayed silent until someone noticed.
            await markCredentialDegraded(name, "anthropic");
          }
        } else {
          // resolveApiKey covers both the configured key and an ambient
          // ANTHROPIC_API_KEY (via pi-ai). We inject it explicitly because the
          // mind env is built from an allowlist and no longer inherits it.
          const apiKey = await resolveApiKey("anthropic");
          if (apiKey) {
            env.ANTHROPIC_API_KEY = apiKey;
            // A host who answers an OAuth outage by switching the provider to a
            // static key gets a mind that spawns healthy down THIS branch. Without
            // clearing here it would stay in the degraded set: wrong badge, and the
            // next probe would "recover" it by restarting a mind that is already fine.
            await noteCredentialHealthy(name);
          }
        }
      } catch (err) {
        mlog.error(`failed to inject Anthropic credentials for ${name}`, log.errorData(err));
      }
    }

    if (isIsolationEnabled()) {
      env.HOME = resolve(dir, "home");
    }

    // Run node directly with tsx as an import loader instead of the tsx bin
    // shim, which would fork a second node process (~60MB RSS) that does
    // nothing. VOLUTE_NODE_PATH (e.g. Electron bundled Node) overrides the
    // node binary. The bare `tsx` specifier resolves against the spawn cwd.
    const baseBin = process.env.VOLUTE_NODE_PATH ?? process.execPath;
    const baseArgs = ["--import", "tsx", "src/server.ts", "--port", String(port)];
    let spawnCmd: string;
    let spawnArgs: string[];
    if (isIsolationEnabled()) {
      [spawnCmd, spawnArgs] = await wrapForIsolation(baseBin, baseArgs, name);
    } else if (isSandboxEnabled() && target.template !== "codex") {
      // Codex minds can't use @anthropic-ai/sandbox-runtime — it blocks Mach IPC
      // services the Codex binary needs (e.g. SCDynamicStore for network config).
      // Codex's own seatbelt sandbox is also disabled due to a system-configuration
      // Rust crate bug (mullvad/system-configuration-rs#59).
      [spawnCmd, spawnArgs] = await wrapForSandbox(baseBin, baseArgs, dir, name, [
        dir,
        mindStateDir,
        mindTmp,
      ]);
    } else {
      spawnCmd = baseBin;
      spawnArgs = baseArgs;
    }

    const spawnOpts: SpawnOptions = {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env,
    };

    const child = spawn(spawnCmd, spawnArgs, spawnOpts);

    this.minds.set(name, { child, port });

    // Pipe output to log file and check for listening
    child.stdout?.pipe(logStream);
    child.stderr?.pipe(logStream);

    // Capture recent stderr for error reporting
    const recentStderr: string[] = [];
    child.stderr?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n").filter(Boolean);
      recentStderr.push(...lines);
      // Keep only last 20 lines
      while (recentStderr.length > 20) recentStderr.shift();
    });

    // stopAll() may have begun during the long stretch above (resolveTarget, the
    // orphan sweep, credential injection). It sets `shuttingDown` before it reads
    // the running set, and this check shares a synchronous stretch with the
    // `this.minds.set` above — so either stopAll saw this child in the map and
    // will stop it, or we see its flag here and stop it ourselves. Without one of
    // those the child outlives the daemon: it has its own process group and
    // `detached: true`, so nothing reaps it (#1048).
    if (this.shuttingDown) {
      await this._stopMind(name);
      throw new DaemonShuttingDownError(name);
    }

    // Poll /health until the server is ready, or reject on a startup budget timeout
    // or an early child exit/error (e.g. a `tsx` syntax error from a self-edit). Polling
    // /health is more robust than scraping stdout for "listening on :PORT".
    try {
      const healthTimeoutMs = opts?.healthTimeoutMs ?? 30000;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const deadline = Date.now() + healthTimeoutMs;

        const onExit = (code: number | null) => {
          // Extract the most useful error line from stderr
          const errorLine = recentStderr.find((l) => l.includes("Error:"));
          const detail = errorLine ? `: ${errorLine.trim()}` : "";
          finish(() =>
            reject(
              new MindStartupError(
                `Mind ${name} exited with code ${code} during startup${detail}`,
                recentStderr.join("\n"),
              ),
            ),
          );
        };
        const onError = (err: Error) => finish(() => reject(err));

        function finish(action: () => void) {
          if (settled) return;
          settled = true;
          child.off("exit", onExit);
          child.off("error", onError);
          action();
        }

        child.on("exit", onExit);
        child.on("error", onError);

        const poll = async () => {
          if (settled) return;
          const { ok } = await checkHealth(port);
          if (settled) return;
          if (ok) {
            finish(() => resolve());
            return;
          }
          if (Date.now() >= deadline) {
            finish(() =>
              reject(
                new MindStartupError(
                  `Mind ${name} did not become healthy within ${Math.round(healthTimeoutMs / 1000)}s`,
                  recentStderr.join("\n"),
                ),
              ),
            );
            return;
          }
          setTimeout(poll, 250);
        };
        void poll();
      });
    } catch (err) {
      this.minds.delete(name);
      try {
        child.kill();
      } catch {}
      throw err;
    }

    // Save PID file for orphan detection on next daemon start
    if (child.pid) {
      try {
        writeFileSync(pidFile, String(child.pid));
      } catch (err) {
        mlog.warn(`failed to write PID file for ${name}`, log.errorData(err));
      }
    }

    // Set up crash recovery after successful start
    this.setupCrashRecovery(name, child);
    await setMindRunning(name, true);

    mlog.info(`started mind ${name} on port ${port}`);

    // Deliver any pending context (e.g. merge info) to the mind via HTTP
    await this.deliverPendingContext(name);

    // Redeliver pending immediate events (failed earlier POSTs, or events that arrived
    // while the mind was stopped). Skipped for sleeping minds — the sleep manager owns
    // the flush there, after the wake summary, so ordering is preserved. Runs on every
    // start path (manual start, daemon boot, crash recovery).
    try {
      const { getSleepManagerIfReady } = await import("./sleep-manager.js");
      if (!getSleepManagerIfReady()?.isSleeping(name)) {
        const { flushQueuedEvents } = await import("../chat/system-events.js");
        const flushed = await flushQueuedEvents(name);
        if (flushed > 0) mlog.info(`redelivered ${flushed} pending event(s) to ${name}`);
      }
    } catch (err) {
      mlog.warn(`failed to flush pending events for ${name} on start`, log.errorData(err));
    }
  }

  setPendingContext(name: string, context: Record<string, unknown>): void {
    persistPendingContext(name, context);
  }

  /** Deliver pending context (merge info, sprout, restart) directly to the mind via HTTP.
   *  Intentionally bypasses DeliveryManager — these are system messages that should not be
   *  routed, gated, or batched. Backed by a durable per-mind file (#330), so context set
   *  before a daemon crash is still delivered on the next start rather than lost. */
  private async deliverPendingContext(name: string): Promise<void> {
    const context = readPendingContext(name);
    if (!context) return;

    const tracked = this.minds.get(name);
    // Leave the queued context on disk for a later start if the mind isn't tracked yet.
    if (!tracked) return;

    clearPendingContext(name);

    const content = await buildPendingContextMessage(name, context);
    const subtype = lifecycleSubtype(context.type);

    // Force delivery: the mind has just started but may not yet be marked awake in
    // sleep state, and this context must reach it regardless.
    await deliverEvent(name, {
      type: "lifecycle",
      body: content,
      meta: { subtype, ...(context.type ? { rawType: String(context.type) } : {}) },
      force: true,
    });
  }

  private setupCrashRecovery(name: string, child: ChildProcess): void {
    // Clear the crash budget only once this spawn has proved it can stay up.
    // Resetting it here at start time let a mind that crashes right after passing
    // its health check refresh its own budget on every attempt, so the backoff and
    // the give-up cap (and with them hasExhaustedRestarts) never engaged (#1033).
    this.restartTracker.armHealthyReset(name, () => this.saveCrashAttempts());

    child.on("exit", async (code) => {
      // Only react if this is still the tracked child. After a restart replaced
      // it, an old child's delayed exit must not delete the new child's entry.
      if (this.minds.get(name)?.child !== child) return;
      // This spawn died before it earned a reset — keep its accumulated count.
      this.restartTracker.cancelHealthyReset(name);
      this.minds.delete(name);
      if (this.shuttingDown || this.stopping.has(name)) return;

      mlog.error(`mind ${name} exited with code ${code}`);

      // If the mind is sleeping (including trigger-wakes), don't attempt crash recovery.
      // During trigger-wakes, the sleep manager handles the process lifecycle.
      try {
        const { getSleepManagerIfReady } = await import("./sleep-manager.js");
        const sleepMgr = getSleepManagerIfReady();
        const sleepState = sleepMgr?.getState(name);
        if (sleepState?.sleeping) {
          if (sleepState.wokenByTrigger && sleepMgr) {
            // A trigger-woken mind crashed mid-window. Don't leave it in
            // sleeping+wokenByTrigger limbo (which gets neither crash recovery
            // nor the idle-driven return-to-sleep) — return it to sleep now.
            mlog.info(`${name} crashed during trigger wake — returning to sleep`);
            void sleepMgr.returnToSleepAfterCrash(name);
          } else {
            mlog.info(`${name} is sleeping — skipping crash recovery`);
          }
          return;
        }
      } catch (err) {
        mlog.warn(`failed to check sleep state for ${name}`, log.errorData(err));
      }

      // Clear turn state and delivery session state so ghost counts don't accumulate.
      // Generate summaries for any orphaned turns before they're lost.
      clearTurnState(name)
        .then((orphaned) => {
          summarizeOrphanedTurns(orphaned);
          // Tell the mind, on its next successful turn in each affected session, that it
          // crashed mid-turn — so the scope of the interruption is clear.
          for (const { session } of orphaned) {
            void recordNotice({
              mind: name,
              thread: session ?? "main",
              kind: "crash",
              reason: "process_crash",
              detail:
                "Your process crashed mid-turn and was automatically restarted. That turn was interrupted before it finished — check whether you left anything incomplete.",
            });
          }
        })
        .catch((err) =>
          mlog.warn(`failed to clear turn state for ${name} after crash`, log.errorData(err)),
        );
      try {
        const { getDeliveryManager } = await import("../delivery/delivery-manager.js");
        getDeliveryManager().clearMindSessions(name);
      } catch (err) {
        if (!(err instanceof Error && err.message.includes("not initialized"))) {
          mlog.warn(`failed to clear delivery state for ${name} after crash`, log.errorData(err));
        }
      }

      // Clear activity tracking and publish crash as mind_stopped
      import("../events/mind-activity-tracker.js")
        .then(({ markIdle }) => markIdle(name))
        .catch((err) => mlog.warn(`failed to mark ${name} idle after crash`, log.errorData(err)));
      import("../events/activity-events.js")
        .then(({ publish }) =>
          publish({ type: "mind_stopped", mind: name, summary: `${name} crashed (exit ${code})` }),
        )
        .catch((err) => mlog.warn(`failed to publish crash event for ${name}`, log.errorData(err)));

      const { shouldRestart, delay, attempt } = this.restartTracker.recordCrash(name);
      this.saveCrashAttempts();
      if (!shouldRestart) {
        mlog.error(`${name} crashed ${attempt} times — giving up on restart`);
        await setMindRunning(name, false);
        return;
      }
      mlog.info(
        `crash recovery for ${name} — attempt ${attempt}/${this.restartTracker.maxRestartAttempts}, restarting in ${delay}ms`,
      );
      setTimeout(() => {
        if (this.shuttingDown) return;
        this.startMind(name).catch((err) => {
          mlog.error(`failed to restart ${name}`, log.errorData(err));
        });
      }, delay);
    });
  }

  async stopMind(name: string): Promise<void> {
    return this.withLock(name, () => this._stopMind(name));
  }

  private async _stopMind(name: string): Promise<void> {
    const tracked = this.minds.get(name);
    if (!tracked) return;

    this.stopping.add(name);
    const { child } = tracked;
    this.minds.delete(name);

    await new Promise<void>((resolve) => {
      // Force kill after 5s — but disarm it on a clean exit so a stray
      // group-SIGKILL can't later fire against a reused pgid.
      const killTimer = setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {}
        resolve();
      }, 5000);
      child.on("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });
      try {
        // Kill the entire process group (node + any children it spawns)
        process.kill(-child.pid!, "SIGTERM");
      } catch {
        clearTimeout(killTimer);
        resolve();
      }
    });

    this.stopping.delete(name);
    revokeMindToken(name);
    try {
      const orphanedTurns = await clearTurnState(name);
      summarizeOrphanedTurns(orphanedTurns);
    } catch (err) {
      mlog.warn(`failed to clear turn state for ${name} on stop`, log.errorData(err));
    }
    try {
      const { getDeliveryManager } = await import("../delivery/delivery-manager.js");
      getDeliveryManager().clearMindSessions(name);
    } catch (err) {
      if (!(err instanceof Error && err.message.includes("not initialized"))) {
        mlog.warn(`failed to clear delivery state for ${name} on stop`, log.errorData(err));
      }
    }
    try {
      const { clearEchoTextCache } = await import("../delivery/echo-text.js");
      clearEchoTextCache(name);
    } catch (err) {
      mlog.debug(`failed to clear echo-text cache for ${name}`, log.errorData(err));
    }

    if (this.restartTracker.reset(name)) this.saveCrashAttempts();
    rmSync(mindPidPath(name), { force: true });

    if (!this.shuttingDown) {
      await setMindRunning(name, false);
    }

    mlog.info(`stopped mind ${name}`);
  }

  async restartMind(name: string): Promise<void> {
    return this.withLock(name, async () => {
      await this._stopMind(name);
      try {
        await this._startMind(name);
      } catch (err) {
        // The stop above cleared `running` (shutdown hadn't begun yet). If the start
        // is then refused because it has, nothing would put that flag back, and the
        // mind drops out of the next boot's set — left down by a restart it never
        // asked to be down for. `stopAll` skips the same write for this reason.
        if (err instanceof DaemonShuttingDownError) await setMindRunning(name, true);
        throw err;
      }
    });
  }

  async stopAll(): Promise<void> {
    this.shuttingDown = true;
    const names = [...this.minds.keys()];
    await Promise.all(names.map((name) => this.stopMind(name)));
  }

  isRunning(name: string): boolean {
    return this.minds.has(name);
  }

  /**
   * True when crash recovery for this mind has used up all restart attempts (the
   * "giving up on restart" state). Cleared by an explicit stop, or once a restarted
   * mind has stayed up long enough to earn a reset.
   */
  hasExhaustedRestarts(name: string): boolean {
    return this.restartTracker.getAttempts(name) >= this.restartTracker.maxRestartAttempts;
  }

  getRunningMinds(): string[] {
    return [...this.minds.keys()];
  }

  private get crashAttemptsPath(): string {
    return resolve(voluteSystemDir(), "crash-attempts.json");
  }

  loadCrashAttempts(): void {
    this.restartTracker.load(loadJsonMap(this.crashAttemptsPath));
  }

  private saveCrashAttempts(): void {
    saveJsonMap(this.crashAttemptsPath, this.restartTracker.save());
  }

  clearCrashAttempts(): void {
    this.restartTracker.clear();
    clearJsonMap(this.crashAttemptsPath, new Map());
  }
}

async function killProcessOnPort(port: number): Promise<void> {
  try {
    const { stdout } = await execFileAsync("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"]);
    const pids = new Set<number>();
    for (const line of stdout.trim().split("\n").filter(Boolean)) {
      const pid = parseInt(line, 10);
      pids.add(pid);
      // Find the process group to kill supervisors/wrappers too
      try {
        const { stdout: psOut } = await execFileAsync("ps", ["-p", String(pid), "-o", "pgid="]);
        const pgid = parseInt(psOut.trim(), 10);
        if (pgid > 1) pids.add(pgid);
      } catch {}
    }
    for (const pid of pids) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {}
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
  } catch {
    // lsof may fail if no process on port — expected
  }
}

let instance: MindManager | null = null;

export function initMindManager(): MindManager {
  if (instance) throw new Error("MindManager already initialized");
  instance = new MindManager();
  return instance;
}

export function getMindManager(): MindManager {
  if (!instance) throw new Error("MindManager not initialized — call initMindManager() first");
  return instance;
}

/** Like getMindManager but returns null instead of throwing when uninitialized. */
export function tryGetMindManager(): MindManager | null {
  return instance;
}
