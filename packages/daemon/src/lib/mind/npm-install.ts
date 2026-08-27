import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { buildMindBaseEnv } from "../daemon/mind-manager.js";
import { exec, gitExec } from "../util/exec.js";
import { isIsolationEnabled, wrapForIsolation } from "./isolation.js";

// Skip npm's audit/funding network round-trips and prefer the local cache —
// installs here always run against a committed lockfile.
const NPM_INSTALL_ARGS = [
  "install",
  "--no-audit",
  "--no-fund",
  "--prefer-offline",
  "--loglevel=error",
];

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

/**
 * Run npm install in a directory, using the mind user's identity when isolation is enabled.
 * This avoids creating root-owned node_modules that the mind can't modify later.
 */
export async function npmInstallAsMind(cwd: string, mindName: string): Promise<void> {
  const [cmd, args] = lowPriorityArgv("npm", NPM_INSTALL_ARGS, hasIonice());
  const env = npmInstallEnv(cwd);
  if (isIsolationEnabled()) {
    const [wrappedCmd, wrappedArgs] = await wrapForIsolation(cmd, args, mindName);
    await exec(wrappedCmd, wrappedArgs, { cwd, env });
  } else {
    await exec(cmd, args, { cwd, env });
  }
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
