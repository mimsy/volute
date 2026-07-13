import { type ChildProcess, execFile, type SpawnOptions, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { getAiConfig, resolveApiKey } from "../ai-service.js";
import { deliverEvent, recordNotice } from "../chat/system-events.js";
import { loadMergedEnv } from "../config/env.js";
import { getSystemName } from "../config/setup.js";
import { chownMindDir, isIsolationEnabled, wrapForIsolation } from "../mind/isolation.js";
import {
  findMind,
  mindDir,
  mindTmpDir,
  setMindRunning,
  stateDir,
  voluteSystemDir,
} from "../mind/registry.js";
import { isSandboxEnabled, wrapForSandbox } from "../mind/sandbox.js";
import { getPrompt } from "../prompts.js";
import { checkHealth } from "../util/health.js";
import { clearJsonMap, loadJsonMap, saveJsonMap } from "../util/json-state.js";
import log from "../util/logger.js";
import { RotatingLog } from "../util/rotating-log.js";
import { writeClaudeCredentials, writePiProviderKey } from "./credential-sync.js";
import { generateMindToken, revokeMindToken } from "./mind-tokens.js";
import { RestartTracker } from "./restart-tracker.js";
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
  private pendingContext = new Map<string, Record<string, unknown>>();
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

  async startMind(name: string): Promise<void> {
    return this.withLock(name, () => this._startMind(name));
  }

  private async _startMind(name: string): Promise<void> {
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
    const mindEnv = loadMergedEnv(name);
    // Prepend mind's .local/bin to PATH for skill commands and volute wrapper
    const mindLocalBin = resolve(dir, "home", ".local", "bin");
    const currentPath = process.env.PATH ?? "";
    const env: Record<string, string | undefined> = {
      ...buildMindBaseEnv(),
      ...mindEnv,
      VOLUTE_MIND: name,
      VOLUTE_STATE_DIR: stateDir(name),
      VOLUTE_MIND_DIR: dir,
      VOLUTE_MIND_PORT: String(port),
      VOLUTE_MIND_TOKEN: mindToken,
      TMPDIR: mindTmp,
      PATH: `${mindLocalBin}:${currentPath}`,
      // Strip CLAUDECODE so the Agent SDK can spawn Claude Code subprocesses
      CLAUDECODE: undefined,
    };

    // For pi minds, inject the system AI provider's API key
    if (target.template === "pi") {
      try {
        const configPath = resolve(dir, "home/.config/config.json");
        if (existsSync(configPath)) {
          const config = JSON.parse(readFileSync(configPath, "utf-8"));
          const modelStr = config.model as string | undefined;
          if (modelStr?.includes(":")) {
            const provider = modelStr.split(":")[0];
            const apiKey = await resolveApiKey(provider);
            if (apiKey) {
              // Write API key to pi-coding-agent auth storage so the mind can use it.
              // The pi template watches auth.json and reloads, so the daemon can
              // push a refreshed OAuth token here without restarting the mind.
              const piAgentDir = resolve(dir, ".mind", "pi-agent");
              await writePiProviderKey(piAgentDir, baseName, provider, apiKey);
              env.PI_CODING_AGENT_DIR = piAgentDir;

              // Also set provider-specific env var as fallback — the sandbox may
              // block proper-lockfile from reading auth.json, so the env var
              // ensures getEnvApiKey() in pi-ai still resolves the key.
              const providerEnvVars: Record<string, string> = {
                openrouter: "OPENROUTER_API_KEY",
                openai: "OPENAI_API_KEY",
                anthropic: "ANTHROPIC_API_KEY",
                google: "GEMINI_API_KEY",
                groq: "GROQ_API_KEY",
                cerebras: "CEREBRAS_API_KEY",
                xai: "XAI_API_KEY",
                mistral: "MISTRAL_API_KEY",
                zai: "ZAI_API_KEY",
              };
              const providerEnv = providerEnvVars[provider];
              if (providerEnv) env[providerEnv] = apiKey;
            } else {
              mlog.warn(
                `no API key found for provider "${provider}" — mind ${name} may fail to start`,
              );
            }
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
          }
        } else {
          // resolveApiKey covers both the configured key and an ambient
          // ANTHROPIC_API_KEY (via pi-ai). We inject it explicitly because the
          // mind env is built from an allowlist and no longer inherits it.
          const apiKey = await resolveApiKey("anthropic");
          if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
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

    // Poll /health until the server is ready, or reject on a startup budget timeout
    // or an early child exit/error (e.g. a `tsx` syntax error from a self-edit). Polling
    // /health is more robust than scraping stdout for "listening on :PORT".
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const deadline = Date.now() + 30000;

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
                  `Mind ${name} did not become healthy within 30s`,
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
    if (this.restartTracker.reset(name)) this.saveCrashAttempts();
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
    this.pendingContext.set(name, context);
  }

  /** Deliver pending context (merge info, sprout, restart) directly to the mind via HTTP.
   *  Intentionally bypasses DeliveryManager — these are system messages that should not be
   *  routed, gated, or batched. */
  private async deliverPendingContext(name: string): Promise<void> {
    const context = this.pendingContext.get(name);
    if (!context) return;

    const tracked = this.minds.get(name);
    if (!tracked) return;

    this.pendingContext.delete(name);

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
    child.on("exit", async (code) => {
      // Only react if this is still the tracked child. After a restart replaced
      // it, an old child's delayed exit must not delete the new child's entry.
      if (this.minds.get(name)?.child !== child) return;
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
              session: session ?? "main",
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
      await this._startMind(name);
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
   * "giving up on restart" state). Cleared by the tracker reset on the next
   * successful start or explicit stop.
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
