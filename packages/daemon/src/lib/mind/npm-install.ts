import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { buildMindBaseEnv } from "../daemon/mind-manager.js";
import { exec, gitExec } from "../util/exec.js";
import log from "../util/logger.js";
import { isIsolationEnabled, wrapForIsolation } from "./isolation.js";

// Skip npm's audit/funding network round-trips — installs here always run
// against a committed lockfile.
const NPM_INSTALL_ARGS = ["install", "--no-audit", "--no-fund", "--loglevel=error"];

/**
 * Preferred on the first attempt only. It saves a registry round-trip per package
 * on a machine whose cache is warm, but it also makes npm resolve versions
 * *against that cache first*: a version the cache has never seen comes back as
 * `ETARGET No matching version found` even though the registry has it (#973 —
 * bardo, Aug 2026, three of four minds). That is a cache-staleness failure
 * reported as a dependency failure, so it is never the last word here.
 */
const PREFER_OFFLINE = "--prefer-offline";

/**
 * Prefix an argv with nice (and ionice where available) so a large install's
 * CPU/disk load can't starve the daemon and other minds. ionice only takes
 * effect under the bfq I/O scheduler; elsewhere it's a harmless no-op.
 */
export function lowPriorityArgv(cmd: string, args: string[], ionice: boolean): [string, string[]] {
  return ionice
    ? ["ionice", ["-c2", "-n7", "nice", "-n19", cmd, ...args]]
    : ["nice", ["-n19", cmd, ...args]];
}

function hasIonice(): boolean {
  return (
    process.platform === "linux" && (existsSync("/usr/bin/ionice") || existsSync("/bin/ionice"))
  );
}

/**
 * The environment `npm install` runs with: the mind-server allowlist, never the
 * daemon's raw `process.env`.
 *
 * `npm install` executes lifecycle scripts (preinstall/install/postinstall) declared
 * in the mind's own package.json — mind-authored code, by definition. The daemon's
 * environment carries `VOLUTE_DAEMON_TOKEN`, the admin token; `runuser` passes the
 * environment it is given straight through, so a lifecycle script would have read it
 * on every dependency-touching upgrade. Scrubbed in both modes: without isolation the
 * script runs as the daemon's own user, which is the worse case, not the safer one.
 *
 * HOME is redirected to the mind's home/ only under isolation (matching the uid
 * switch, and keeping npm's cache inside the mind's own directory); without
 * isolation the daemon's HOME carries through from the allowlist, so npm resolves
 * its usual cache and .npmrc.
 */
export function npmInstallEnv(cwd: string): NodeJS.ProcessEnv {
  const env = { ...buildMindBaseEnv() };
  return isIsolationEnabled() ? { ...env, HOME: resolve(cwd, "home") } : env;
}

/** The runner npm install goes through; injectable so tests can drive both attempts. */
export type NpmRunner = (
  cmd: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
) => Promise<unknown>;

/** One npm install attempt, wrapped for low priority and (under isolation) for the mind's uid. */
async function runNpmInstall(
  cwd: string,
  mindName: string,
  args: string[],
  run: NpmRunner,
): Promise<void> {
  const [cmd, priorityArgs] = lowPriorityArgv("npm", args, hasIonice());
  const env = npmInstallEnv(cwd);
  if (isIsolationEnabled()) {
    // Re-wrapped per attempt: the argv differs between attempts, and the
    // isolation wrapper embeds it.
    const [wrappedCmd, wrappedArgs] = await wrapForIsolation(cmd, priorityArgs, mindName);
    await run(wrappedCmd, wrappedArgs, { cwd, env });
  } else {
    await run(cmd, priorityArgs, { cwd, env });
  }
}

/**
 * Run npm install in a directory, using the mind user's identity when isolation is enabled.
 * This avoids creating root-owned node_modules that the mind can't modify later.
 *
 * Two attempts: the first prefers the mind's local npm cache; a failure that looks
 * like the cache resolving a version it has never seen is retried once against the
 * registry without {@link PREFER_OFFLINE}. The nice/ionice wrapping is what protects
 * slow storage here, not the cache preference, so dropping the flag costs nothing
 * that matters.
 *
 * The retry is gated rather than unconditional because attempt two *must* reach the
 * registry. When attempt one failed for an unrelated reason — network down, proxy
 * misconfigured, EACCES out of the isolation wrapper — retrying turns a fast local
 * failure into minutes of npm's own fetch-retry backoff, and this path is awaited by
 * the daemon's HTTP handler on `mind create` and `mind split`, not just by upgrades.
 */
export async function npmInstallAsMind(
  cwd: string,
  mindName: string,
  run: NpmRunner = exec,
): Promise<void> {
  try {
    await runNpmInstall(cwd, mindName, [...NPM_INSTALL_ARGS, PREFER_OFFLINE], run);
    return;
  } catch (err) {
    if (!isStaleCacheFailure(err)) throw err;
    // Keep the first failure's evidence even when the retry succeeds — otherwise a
    // cache that is rotting silently looks like nothing ever happened.
    log.warn(
      `npm install with ${PREFER_OFFLINE} failed for ${mindName}; retrying against the registry`,
      log.errorData(err),
    );
  }
  await runNpmInstall(cwd, mindName, NPM_INSTALL_ARGS, run);
}

/**
 * Whether a failed install looks like {@link PREFER_OFFLINE} resolving against a cache
 * that has never seen the requested version — the #973 signature. `ETARGET` is what npm
 * reports for it, `ENOTCACHED` for the stricter offline modes; the plain-English form is
 * matched too because npm has moved which of them it prints. Both stderr and the error
 * message are searched: a failure raised before npm even ran (the isolation wrapper
 * throwing, say) has no stderr at all, and must not qualify.
 */
export function isStaleCacheFailure(err: unknown): boolean {
  const e = err as { stderr?: string; message?: string } | null;
  const text = `${e?.stderr ?? ""}\n${e?.message ?? ""}`;
  return /ETARGET|ENOTCACHED|No matching version/i.test(text);
}

/**
 * True if package.json or package-lock.json changed between fromRef and HEAD.
 * Errs on the side of true (install) if the diff can't be computed.
 */
export async function depsChangedSince(dir: string, fromRef: string): Promise<boolean> {
  try {
    await gitExec(["diff", "--quiet", fromRef, "HEAD", "--", "package.json", "package-lock.json"], {
      cwd: dir,
    });
    return false;
  } catch {
    return true;
  }
}

/**
 * Whether a merge landed anything that requires an npm install. Skipping the
 * no-op case matters: npm install rewrites enough of node_modules to saturate
 * slow storage for a minute even when nothing changed.
 */
export async function npmInstallNeeded(dir: string, preMergeRef: string): Promise<boolean> {
  if (!existsSync(resolve(dir, "node_modules"))) return true;
  return depsChangedSince(dir, preMergeRef);
}
