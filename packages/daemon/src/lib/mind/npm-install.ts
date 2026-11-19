import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { exec, gitExec } from "../util/exec.js";
import log from "../util/logger.js";
import { buildMindBaseEnv } from "../util/mind-env.js";
import {
  isIsolationEnabled,
  mindGitOpts,
  reclaimNodeModules,
  wrapForIsolation,
} from "./isolation.js";

// Skip npm's audit/funding network round-trips.
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
  options: { cwd: string; env?: NodeJS.ProcessEnv; supervised?: boolean },
) => Promise<unknown>;

/** One npm command, wrapped for low priority and (under isolation) for the mind's uid. */
async function runNpmAsMind(
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
    const [wrappedCmd, wrappedArgs, supervised] = await wrapForIsolation(
      cmd,
      priorityArgs,
      mindName,
    );
    await run(wrappedCmd, wrappedArgs, { cwd, env, supervised });
  } else {
    await run(cmd, priorityArgs, { cwd, env });
  }
}

/**
 * Run npm install in a directory, using the mind user's identity when isolation is enabled.
 * This avoids creating root-owned node_modules that the mind can't modify later, and
 * keeps npm off the daemon's HOME, which a hardened service unit may hide entirely
 * (`ProtectHome=yes` makes `/root` unreachable, so npm can't create its cache there).
 * `packages`, when given, are added to the project (a skill's npm dependencies).
 * Root-owned residue in node_modules from an earlier root-run npm is handed back
 * to the mind first, or npm would fail on it with EACCES (#1231).
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
 * For the same reason a stale-cache failure is not retried when the registry's name
 * doesn't resolve: that is npm offline, and it throws {@link RegistryUnreachableError}.
 */
export async function npmInstallAsMind(
  cwd: string,
  mindName: string,
  packages: string[] = [],
  run: NpmRunner = exec,
  reachable: () => Promise<boolean> = registryReachable,
): Promise<void> {
  await reclaimNodeModules(cwd, mindName);
  try {
    await runNpmAsMind(cwd, mindName, [...NPM_INSTALL_ARGS, PREFER_OFFLINE, ...packages], run);
    return;
  } catch (err) {
    if (!isStaleCacheFailure(err)) throw err;
    // Offline, npm falls back to whatever packument its cache holds and reports a
    // version that cache has never seen as ETARGET — the same words as #973, a
    // different cause. A registry retry then can't reach the registry either: it
    // only repeats minutes of fetch backoff and says the same wrong thing twice.
    if (!(await reachable())) throw new RegistryUnreachableError(err);
    // Keep the first failure's evidence even when the retry succeeds — otherwise a
    // cache that is rotting silently looks like nothing ever happened.
    log.warn(
      `npm install with ${PREFER_OFFLINE} failed for ${mindName}; retrying against the registry`,
      log.errorData(err),
    );
  }
  await runNpmAsMind(cwd, mindName, [...NPM_INSTALL_ARGS, ...packages], run);
}

/** The registry Volute's templates install from; its DNS answer is the reachability signal. */
export const REGISTRY_HOST = "registry.npmjs.org";

/** How long a registry lookup may take before the registry counts as unreachable. */
const REGISTRY_LOOKUP_TIMEOUT_MS = 5000;

/**
 * Whether the npm registry's hostname resolves right now. Cheap, and the one signal
 * npm's own `--loglevel=error` output never carries: bardo's offline install (Nov
 * 2026) printed only `ETARGET No matching version found`, while the `EAI_AGAIN` that
 * caused it was in the debug log. A name that resolves is not proof the registry
 * answers, so this only ever turns "unreachable" into a claim — never "reachable".
 */
export async function registryReachable(
  resolveHost: (host: string) => Promise<unknown> = lookup,
  timeoutMs = REGISTRY_LOOKUP_TIMEOUT_MS,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((done) => {
    timer = setTimeout(() => done(false), timeoutMs);
  });
  try {
    return await Promise.race([
      resolveHost(REGISTRY_HOST).then(
        () => true,
        () => false,
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * An install that failed with npm's stale-cache signature while the registry could not
 * be resolved: a network outage, not a missing version, whatever npm's output says.
 * Carries the failed attempt's stderr so callers can still show npm's own words.
 */
export class RegistryUnreachableError extends Error {
  readonly stderr: string;
  constructor(cause: unknown) {
    super(`npm could not reach the registry (${REGISTRY_HOST} did not resolve)`, { cause });
    this.name = "RegistryUnreachableError";
    this.stderr = String((cause as { stderr?: string } | null)?.stderr ?? "");
  }
}

/**
 * Whether the mind's installed packages satisfy its package.json, by `npm ls`: read-only,
 * offline, and seconds rather than the minutes even a no-op install costs slow storage.
 * Run as the mind, like the install, so npm's own files land in the mind's HOME as its
 * own. Any failure — a missing or mismatched package, or npm not running at all — reads
 * as not satisfied, which only costs an install.
 */
export async function npmDepsSatisfied(
  cwd: string,
  mindName: string,
  run: NpmRunner = exec,
): Promise<boolean> {
  if (!existsSync(resolve(cwd, "node_modules"))) return false;
  try {
    await runNpmAsMind(cwd, mindName, ["ls", "--depth=0", "--loglevel=silent"], run);
    return true;
  } catch {
    return false;
  }
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
 * Whether a failed install looks like the network rather than the project: a dropped or
 * refused connection, a timeout, a name that didn't resolve, the registry answering 5xx,
 * or a proxy or captive portal answering with something that isn't JSON. DNS resolving
 * proves none of these away, so a failure of this shape is never reported as "the
 * registry was reachable".
 *
 * Codes are matched as codes — whole, case-sensitive words — because npm's output also
 * carries integrity digests, tarball URLs and cache paths, and a stray "e503" in base64
 * would otherwise read a disk-full or permissions failure as a network blip, which is
 * never reported and retried hourly forever. A 5xx only counts on npm's own code line
 * (`npm error code E503`, checked against npm 11), since base64 can bound a bare `E503`
 * with `+` or `/`. Node's errno names count wherever they appear (`connect ECONNREFUSED`,
 * `getaddrinfo ENOTFOUND`, `reason: read ECONNRESET`).
 */
const NETWORK_ERRNO =
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPIPE)\b/;
const NETWORK_HTTP_CODE = /\bcode E5\d\d\b/;
const NETWORK_PHRASE = /socket hang up|invalid json response/i;

export function isNetworkFailure(err: unknown): boolean {
  const e = err as { stderr?: string; message?: string } | null;
  const text = `${e?.stderr ?? ""}\n${e?.message ?? ""}`;
  return NETWORK_ERRNO.test(text) || NETWORK_HTTP_CODE.test(text) || NETWORK_PHRASE.test(text);
}

const PACKAGE_FILES = ["package.json", "package-lock.json"];

/**
 * Commit, as the mind, whatever an install changed in its package files. The install
 * after a merge can rewrite the lockfile npm was handed — on the first attempt
 * or on the registry retry — and left uncommitted that is noise in the mind's own
 * `git status` that its next upgrade or join sweeps into an unrelated auto-commit
 * (#1385). Only the package files are committed, so anything else staged is left
 * alone. Returns whether a commit was made.
 */
export async function commitDepsChanges(
  dir: string,
  mindName: string,
  message: string,
): Promise<boolean> {
  const git = mindGitOpts(dir, mindName);
  // Only the files that actually changed: a pathspec naming a file that is neither on
  // disk nor tracked (a mind with no lockfile) fails the whole add.
  const changed = (await gitExec(["status", "--porcelain", "--", ...PACKAGE_FILES], git))
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => line.slice(3));
  if (changed.length === 0) return false;
  await gitExec(["add", "--", ...changed], git);
  await gitExec(["commit", "-m", message, "--", ...changed], git);
  return true;
}

/**
 * True if package.json or package-lock.json changed between fromRef and HEAD.
 * Errs on the side of true (install) if the diff can't be computed.
 */
export async function depsChangedSince(
  dir: string,
  fromRef: string,
  mindName: string,
): Promise<boolean> {
  try {
    await gitExec(
      ["diff", "--quiet", fromRef, "HEAD", "--", "package.json", "package-lock.json"],
      mindGitOpts(dir, mindName),
    );
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
export async function npmInstallNeeded(
  dir: string,
  preMergeRef: string,
  mindName: string,
): Promise<boolean> {
  if (!existsSync(resolve(dir, "node_modules"))) return true;
  return depsChangedSince(dir, preMergeRef, mindName);
}
