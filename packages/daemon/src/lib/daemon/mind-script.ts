import { resolve } from "node:path";
import { loadMergedEnv } from "../config/env.js";
import { findMind, mindDir, mindTmpDir, mindTmpEnv, stateDir } from "../mind/registry.js";
import { isSandboxEnabled, wrapForSandbox } from "../mind/sandbox.js";
import { exec } from "../util/exec.js";
import { buildMindBaseEnv } from "./mind-manager.js";
import { issueScriptToken, revokeScriptToken } from "./mind-tokens.js";

/**
 * Cap on a mind script's stdout, set deliberately rather than inherited.
 *
 * The wake hook used to run under a raw `spawn` with no bound at all, and going
 * through `execFile` looks like it would impose that function's 1MB default. It
 * does not, but only by accident: `exec()` always passes the `maxBuffer` key, and
 * Node reads an explicit `undefined` as "no limit" (measured on v24 — 2MB of
 * output comes back whole with `undefined`, and errors with an explicit 1MB).
 * Leaning on that is the same shape of accidental guarantee this change exists to
 * remove, so the bound is stated here instead.
 *
 * It is set high because overflow is not truncation: `execFile` kills the child
 * and the caller gets *nothing*. A mind growing its own wake hook is the
 * documented, encouraged thing to do, and losing all of its wake context to a
 * limit nobody told it about is exactly the invisible failure #864 was about. The
 * bound exists only so a runaway script can't grow the daemon's heap without end.
 */
export const MIND_SCRIPT_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Build the environment for a mind-authored script — mirrors the mind process env
 * (allowlisted base + merged mind env + VOLUTE_* runtime vars), authenticated
 * with a per-run, non-admin token minted for this script alone (see
 * `issueScriptToken`) — not the running mind's own token, so the mind's agent
 * process never holds the credential and the daemon can tell a process it spawned
 * from one merely claiming to be self-initiated. Callers must revoke it when the
 * run ends; {@link runMindScript} does. The daemon admin token is never included.
 */
export async function buildMindScriptEnv(
  mindName: string,
  dir?: string,
): Promise<Record<string, string | undefined>> {
  const mindHome = dir ?? mindDir(mindName);
  const entry = await findMind(mindName);
  const token = issueScriptToken(mindName);
  const mindLocalBin = resolve(mindHome, "home", ".local", "bin");
  const currentPath = process.env.PATH ?? "";
  return {
    ...buildMindBaseEnv(),
    ...loadMergedEnv(mindName),
    VOLUTE_MIND: mindName,
    VOLUTE_STATE_DIR: stateDir(mindName),
    VOLUTE_MIND_DIR: mindHome,
    VOLUTE_MIND_PORT: entry ? String(entry.port) : undefined,
    VOLUTE_MIND_TOKEN: token,
    ...mindTmpEnv(mindHome),
    PATH: `${mindLocalBin}:${currentPath}`,
  };
}

/**
 * Run a mind-authored script (scheduled scripts, lifecycle hooks) on the mind's
 * behalf, with as little of the daemon's authority as the configuration allows.
 *
 * Two guarantees, and they are not equally strong — don't read the first as the
 * second:
 *
 * 1. **Environment: unconditional.** The script always gets the allowlisted mind
 *    env from {@link buildMindScriptEnv} — never the daemon's `process.env`, and
 *    never `VOLUTE_DAEMON_TOKEN`. This holds in every isolation mode.
 * 2. **Process isolation: only as strong as the configured mode.** Under
 *    `sandbox` the script is wrapped with the mind's sandbox (exec applies user
 *    isolation, never the sandbox); under `user`, `mindName` goes to exec so it
 *    runs as the mind's OS user. The two are mutually exclusive. Under isolation
 *    `none` neither applies — `wrapForIsolation` returns the argv unchanged — so
 *    the script runs as the daemon's own user, which on a `--system` install is
 *    root. That is what `none` means rather than a gap here, but it is why this
 *    docblock does not say "never in the daemon's trust domain": on `none`, it is.
 *
 * On `timeout` under sandbox mode: the script is not the immediate child —
 * wrapForSandbox returns `["bash", ["-c", "env … sandbox-exec … '<script>'"]]` —
 * and exec's timeout signals only that immediate child. That wrapped string is a
 * single simple command, so bash exec-replaces itself down the chain and the
 * signal reaches the script itself (verified against the real sandbox runtime).
 * A wrapper that grew into a compound command would fork instead, and a timed-out
 * script would be orphaned rather than killed.
 */
export async function runMindScript(
  cmd: string,
  args: string[],
  opts: {
    mindName: string;
    /** Mind directory; defaults to the registry path (pass for variant overrides). */
    dir?: string;
    cwd?: string;
    /** Written to the script's stdin, which is then closed. */
    stdin?: string;
    /** Milliseconds before the script is killed. */
    timeout?: number;
    /** Max stdout bytes; defaults to {@link MIND_SCRIPT_MAX_BUFFER}. */
    maxBuffer?: number;
  },
): Promise<string> {
  const dir = opts.dir ?? mindDir(opts.mindName);
  const env = await buildMindScriptEnv(opts.mindName, dir);
  const { cwd, stdin, timeout } = opts;
  const maxBuffer = opts.maxBuffer ?? MIND_SCRIPT_MAX_BUFFER;

  try {
    if (isSandboxEnabled()) {
      const [wrappedCmd, wrappedArgs] = await wrapForSandbox(cmd, args, dir, opts.mindName, [
        dir,
        mindTmpDir(dir),
      ]);
      return await exec(wrappedCmd, wrappedArgs, { cwd, env, stdin, timeout, maxBuffer });
    }
    return await exec(cmd, args, { cwd, mindName: opts.mindName, env, stdin, timeout, maxBuffer });
  } finally {
    // Bounds the credential to the run rather than to its TTL — see `issueScriptToken`
    // for why that bound is the one worth having. Work the script backgrounded loses its
    // token here; that is the accepted cost.
    if (env.VOLUTE_MIND_TOKEN) revokeScriptToken(env.VOLUTE_MIND_TOKEN);
  }
}
