import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { daemonNotice } from "./daemon-client.js";
import { log } from "./logger.js";

/** How a hook failed. Set by {@link executeHook} only when the hook did not succeed. */
export type HookFailure = {
  kind: "timeout" | "exit" | "spawn" | "invalid_output";
  /** One plain sentence, e.g. "timed out after 15000ms". */
  summary: string;
  /** What the hook wrote to stderr (or the bad stdout), trimmed — may be empty. */
  output: string;
};

export type HookResult = {
  additionalContext?: string;
  metadata?: Record<string, unknown>;
  decision?: "block";
  failure?: HookFailure;
};

export type AggregatedResult = {
  additionalContext?: string;
  metadata: Record<string, unknown>;
  blocked: boolean;
};

/**
 * How long a hook may run before it is killed.
 *
 * 5s was too tight where it mattered most: on a Raspberry Pi, `tsx` cold start
 * alone can eat it, and the pre-prompt hooks — the mind's only channel for its
 * own next-turn notices — were being killed hundreds of times per mind per
 * fortnight. A hook that is merely slow should still be heard.
 *
 * Read per call rather than captured once, so a host can retune it without
 * rebuilding: `VOLUTE_HOOK_TIMEOUT_MS`, a positive integer in milliseconds.
 */
export function defaultHookTimeout(): number {
  const raw = Number(process.env.VOLUTE_HOOK_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 15000;
}

/**
 * Discover hook scripts in `.local/hooks/<event>/`, sorted alphabetically.
 *
 * An empty file is skipped rather than run. Emptying a hook is the mind's way of
 * saying "not this one" — an empty script always was a no-op (it exits 0 with no
 * stdout, which {@link executeHook} reads as `{}`), but running it still paid a
 * process spawn, and for a `.ts` hook a whole `tsx` cold start, on every turn.
 * Declining a hook should cost nothing.
 */
export function discoverHooks(hooksDir: string, event: string): string[] {
  const dir = resolve(hooksDir, event);
  if (!existsSync(dir)) return [];

  try {
    return readdirSync(dir)
      .filter((f) => /\.(sh|ts|js)$/.test(f))
      .sort()
      .map((f) => join(dir, f))
      .filter((path) => {
        // A file we cannot stat is left in the list: executeHook reports its own
        // failure clearly, and silently dropping a hook is the worse error.
        try {
          return statSync(path).size > 0;
        } catch {
          return true;
        }
      });
  } catch (err) {
    log(
      "hooks",
      `failed to read hooks directory ${dir}: ${err instanceof Error ? err.message : err}`,
    );
    return [];
  }
}

/**
 * Select the runner command for a hook script based on its extension.
 */
function getRunner(scriptPath: string): { cmd: string; args: string[] } {
  const ext = extname(scriptPath);
  if (ext === ".ts") return { cmd: process.execPath, args: ["--import", "tsx", scriptPath] };
  if (ext === ".js") return { cmd: "node", args: [scriptPath] };
  return { cmd: "bash", args: [scriptPath] };
}

/**
 * Execute a single hook script with JSON on stdin, parse JSON from stdout.
 */
export function executeHook(
  scriptPath: string,
  input: object,
  timeout = defaultHookTimeout(),
  cwd?: string,
): Promise<HookResult> {
  return new Promise((resolve) => {
    const { cmd, args } = getRunner(scriptPath);
    const startedAt = Date.now();
    const child = spawn(cmd, args, {
      timeout,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: cwd ?? process.cwd(),
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    // Ignore stdin errors — child may exit before reading (EPIPE)
    child.stdin.on("error", () => {});
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();

    let settled = false;
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        // spawn()'s `timeout` kills the child with a signal, so the exit code is
        // null and the old message read "exited with code null" — which sent
        // whoever was reading the log looking for a crash that never happened.
        // spawn()'s timeout kills with `killSignal`, which defaults to SIGTERM.
        // Requiring that signal keeps an OOM kill (SIGKILL) from being reported
        // as a timeout, and the small tolerance absorbs a timer firing a
        // millisecond early. A host SIGTERM landing within a millisecond of the
        // budget would still be misread; that is the residual ambiguity.
        const timedOut =
          code === null && signal === "SIGTERM" && Date.now() - startedAt >= timeout - 50;
        log(
          "hooks",
          timedOut
            ? `hook ${scriptPath} timed out after ${timeout}ms (killed with ${signal}); ` +
                `raise VOLUTE_HOOK_TIMEOUT_MS if it needs longer: ${stderr.trim()}`
            : `hook ${scriptPath} exited with code ${code}${signal ? ` (${signal})` : ""}: ${stderr.trim()}`,
        );
        resolve({
          failure: timedOut
            ? { kind: "timeout", summary: `timed out after ${timeout}ms`, output: stderr.trim() }
            : {
                kind: "exit",
                summary: signal ? `was killed by ${signal}` : `exited with code ${code}`,
                output: stderr.trim(),
              },
        });
        return;
      }

      const trimmed = stdout.trim();
      if (!trimmed) {
        resolve({});
        return;
      }

      try {
        const parsed = JSON.parse(trimmed);
        resolve({
          additionalContext: parsed.additionalContext,
          metadata: parsed.metadata,
          decision: parsed.decision,
        });
      } catch {
        log("hooks", `hook ${scriptPath} returned invalid JSON: ${trimmed.slice(0, 200)}`);
        resolve({
          failure: {
            kind: "invalid_output",
            summary: "printed something that isn't JSON",
            output: trimmed.slice(0, 200),
          },
        });
      }
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      log("hooks", `hook ${scriptPath} failed to spawn: ${err.message}`);
      resolve({ failure: { kind: "spawn", summary: "couldn't be started", output: err.message } });
    });
  });
}

/**
 * Discover and run all hooks for an event, aggregating results.
 */
export async function runHooks(
  hooksDir: string,
  event: string,
  input: object,
  timeout = defaultHookTimeout(),
): Promise<AggregatedResult> {
  const scripts = discoverHooks(hooksDir, event);
  if (scripts.length === 0) return { metadata: {}, blocked: false };

  // Hook shim scripts use paths relative to the mind's home directory
  // (e.g. .claude/skills/<id>/scripts/<script>). hooksDir is <home>/.local/hooks,
  // so resolving ../.. gives the home directory.
  const homeDir = resolve(hooksDir, "../..");

  const contextParts: string[] = [];
  const metadata: Record<string, unknown> = {};
  let blocked = false;

  // Hooks run in series, so the per-hook budget is also a per-hook *stall* the
  // mind waits through before every turn. Raising it to 15s without an aggregate
  // cap would have made the worst case 45s on the three pre-prompt hooks `_base`
  // ships — worse than the 5s-each it replaces. Budget the whole event instead.
  //
  // The order this prioritises is discoverHooks' alphabetical sort, which puts
  // notices.ts (the next-turn drain) first, then session-activity.ts, then
  // turn-context.ts. So the drain gets the full budget and the last hook is the
  // one squeezed — the right way round for this trade. The floor keeps a
  // squeezed hook from being spawned with a zero timeout (killed on arrival);
  // under sustained slowness the last hook may get only that floor, which for a
  // tsx hook is not enough to cold-start. Bounded stall, prioritised by sort
  // order, tail hook sacrificed.
  const deadline = Date.now() + timeout;
  const MIN_HOOK_MS = 1000;

  for (const script of scripts) {
    const remaining = Math.max(MIN_HOOK_MS, deadline - Date.now());
    const result = await executeHook(script, input, Math.min(timeout, remaining), homeDir);
    if (result.failure) {
      const told = tellMindAboutHookFailure(script, homeDir, event, result.failure);
      if (told) contextParts.push(told);
    }
    if (result.additionalContext) {
      contextParts.push(result.additionalContext);
    }
    if (result.metadata) {
      Object.assign(metadata, result.metadata);
    }
    if (result.decision === "block") {
      blocked = true;
    }
  }

  return {
    additionalContext: contextParts.length > 0 ? contextParts.join("\n\n") : undefined,
    metadata,
    blocked,
  };
}

/**
 * How long one hook's failure of one kind stays quiet after the mind has been told
 * about it. A hook that fails every turn would otherwise put the same notice in front
 * of the mind every turn; once an hour is enough to know it is still happening.
 * In-memory, so a restarted server tells the mind again — a fresh start is a fair
 * moment to repeat it.
 */
export const HOOK_FAILURE_QUIET_MS = 60 * 60 * 1000;

const lastTold = new Map<string, number>();

/** Forget which failures have been told — for tests. */
export function resetHookFailureDedupe(): void {
  lastTold.clear();
}

/**
 * The next-turn notices drain. Its own failure can't travel through the notices it
 * delivers, so it is told in-band instead (see {@link tellMindAboutHookFailure}).
 */
function isNoticesDrain(scriptPath: string, event: string): boolean {
  return (
    event === "pre-prompt" &&
    basename(dirname(scriptPath)) === "pre-prompt" &&
    /^notices\.(ts|js|sh)$/.test(basename(scriptPath))
  );
}

/**
 * Tell the mind, plainly, that part of its own machinery failed (#938). Without this
 * the failure goes only to mind.log, and the mind learns about it by noticing a
 * symptom and guessing.
 *
 * Most failures go to the daemon as a `hook_failed` notice, which the notices drain
 * delivers on the next turn — fire-and-forget, so reporting never adds to the turn's
 * wait. Recording a notice runs no hooks, so there is no loop.
 *
 * The drain itself is the exception: a notice about the drain failing would sit behind
 * the very hook that isn't working. So for the drain, on a pre-prompt event, the note
 * is returned for the caller to put straight into this turn's context. A failing
 * drain on any other event can't happen (it only runs on pre-prompt).
 *
 * Returns in-band text to add to this turn's context, or undefined.
 */
function tellMindAboutHookFailure(
  scriptPath: string,
  homeDir: string,
  event: string,
  failure: HookFailure,
): string | undefined {
  const key = `${scriptPath}\n${failure.kind}`;
  const now = Date.now();
  const last = lastTold.get(key);
  if (last !== undefined && now - last < HOOK_FAILURE_QUIET_MS) return undefined;
  lastTold.set(key, now);

  const hook = relative(homeDir, scriptPath);
  const output = failure.output ? `\nIt said:\n${clip(failure.output)}` : "";
  const quiet = `If it keeps failing you'll hear about it again in about an hour, not every turn; the full lines are in $VOLUTE_STATE_DIR/logs/mind.log.`;

  if (isNoticesDrain(scriptPath, event)) {
    return (
      `[Your hooks] Your notices hook (${hook}) ${failure.summary}, so any notices ` +
      `waiting for you couldn't be delivered this turn — they're kept until it works. ` +
      `${quiet}${output}`
    );
  }

  // No daemon to tell (tests, or a server run by hand): the log line is all there is.
  if (!process.env.VOLUTE_DAEMON_PORT || !process.env.VOLUTE_MIND) return undefined;
  daemonNotice({
    kind: "hook_failed",
    message:
      `Your ${event} hook ${hook} ${failure.summary}, so whatever it adds was skipped ` +
      `that time. It's part of your own machinery — yours to read, fix, or remove. ` +
      `${quiet}${output}`,
  }).catch(() => {});
  return undefined;
}

function clip(text: string): string {
  const MAX = 1000;
  return text.length > MAX ? `…${text.slice(-MAX)}` : text;
}
