import { execFileSync } from "node:child_process";
import { constants, existsSync, type Stats, statSync } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { alertHost } from "../chat/system-events.js";
import { chownBelow } from "../util/chown-tree.js";
import { exec } from "../util/exec.js";
import log from "../util/logger.js";
import { resolveRealWithinBase } from "../util/paths.js";
import { getBaseName, isSpiritName, resolveMindDir, validateMindName } from "./registry.js";

const ilog = log.child("isolation");

/**
 * Users this process has confirmed exist. Populated on a successful `id` lookup
 * or a successful repair, and evicted by `deleteMindUser`, so the existence
 * check costs one subprocess per mind per daemon lifetime rather than one per
 * exec.
 */
const knownUsers = new Set<string>();

/**
 * Numeric uid/gid of each mind user, for the handle-based chowns. Cached like
 * `knownUsers` (and evicted with it) so a chown doesn't spawn its id lookups
 * every time; a repaired user keeps its ids, so a repair needs no eviction.
 */
const ownerIds = new Map<string, { uid: number; gid: number }>();

/** Returns true when per-mind user isolation is enabled. */
export function isIsolationEnabled(): boolean {
  return process.env.VOLUTE_ISOLATION === "user";
}

/** Username for a mind. Prefix configurable via VOLUTE_USER_PREFIX (default: "mind-"). */
export function mindUserName(mindName: string): string {
  const err = validateMindName(mindName);
  // Allow the spirit — its name is reserved/rejected for minds but gets the prefix too
  if (err && !isSpiritName(mindName)) {
    throw new Error(`Invalid mind name for isolation: ${err}`);
  }
  const prefix = process.env.VOLUTE_USER_PREFIX ?? "mind-";
  return `${prefix}${mindName}`;
}

/** Numeric ids in `dscl . -list /<type> <idField>` output. */
export function parseDsclIds(output: string): Set<number> {
  const ids = new Set<number>();
  for (const line of output.split("\n")) {
    const parts = line.trim().split(/\s+/);
    const id = parseInt(parts[parts.length - 1], 10);
    if (!Number.isNaN(id)) ids.add(id);
  }
  return ids;
}

/**
 * The uid/gid to create a macOS account on: `pinned` when it is genuinely free,
 * otherwise the next id above 400.
 *
 * The pinned case is the repair path, and macOS is the platform where it needs
 * its own guard: `dscl -create UniqueID` will happily mint a second account on a
 * live uid, and there is no macOS equivalent of `useradd`'s "UID is not unique"
 * refusal to catch it afterwards. So the check happens here, against the same
 * directory-service enumeration the fresh-id allocation trusts. Throws rather
 * than silently allocating elsewhere: a repair that lands on a different uid
 * than the one owning the files is not a repair.
 */
export function macIdToCreate(pinned: number | undefined, taken: Set<number>): number {
  if (pinned !== undefined) {
    if (taken.has(pinned)) {
      throw new Error(`id ${pinned} is already in use — refusing to create a duplicate`);
    }
    return pinned;
  }
  let next = 401;
  while (taken.has(next)) next++;
  return next;
}

/** Read the assigned UIDs (or GIDs) from the local directory service. */
function macTakenIds(type: "Users" | "Groups"): Set<number> {
  const idField = type === "Users" ? "UniqueID" : "PrimaryGroupID";
  try {
    return parseDsclIds(
      execFileSync("dscl", [".", "-list", `/${type}`, idField], { encoding: "utf-8" }),
    );
  } catch (err) {
    throw new Error(
      `Failed to query ${type} via dscl: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/** Find next available UID/GID above 400 on macOS. */
function findNextMacId(type: "Users" | "Groups"): number {
  return macIdToCreate(undefined, macTakenIds(type));
}

/** Get the GID of the volute group. */
function getVoluteGroupGid(): number {
  if (process.platform === "darwin") {
    const output = execFileSync("dscl", [".", "-read", "/Groups/volute", "PrimaryGroupID"], {
      encoding: "utf-8",
    });
    const match = output.match(/PrimaryGroupID:\s*(\d+)/);
    if (!match) throw new Error("Could not read volute group GID");
    return parseInt(match[1], 10);
  }
  // Linux: parse from getent
  const output = execFileSync("getent", ["group", "volute"], { encoding: "utf-8" });
  const gid = parseInt(output.split(":")[2], 10);
  if (Number.isNaN(gid)) throw new Error("Could not read volute group GID");
  return gid;
}

/** Create the shared `volute` group (idempotent). Pass `force: true` to skip the isolation env check. */
export function ensureVoluteGroup(opts?: { force?: boolean }): void {
  if (!opts?.force && !isIsolationEnabled()) return;

  if (process.platform === "darwin") {
    try {
      execFileSync("dscl", [".", "-read", "/Groups/volute"], { stdio: "ignore" });
      return; // already exists
    } catch {
      // Group doesn't exist — create it
    }
    const gid = findNextMacId("Groups");
    try {
      execFileSync("dscl", [".", "-create", "/Groups/volute"]);
      execFileSync("dscl", [".", "-create", "/Groups/volute", "PrimaryGroupID", String(gid)]);
      execFileSync("dscl", [".", "-create", "/Groups/volute", "Password", "*"]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to create volute group on macOS: ${msg}`);
    }
    return;
  }

  // Linux
  try {
    execFileSync("getent", ["group", "volute"], { stdio: "ignore" });
  } catch {
    try {
      execFileSync("groupadd", ["volute"], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (err) {
      const stderr = (err as { stderr?: Buffer })?.stderr?.toString().trim();
      throw new Error(`Failed to create volute group${stderr ? `: ${stderr}` : ""}`);
    }
  }
}

/**
 * Whether `groupadd` still needs to run for a mind's own Linux group.
 *
 * A repair that created the group and then failed at `useradd` leaves the group
 * behind, and that orphan must not block the retry — but only when it carries
 * the gid we actually need. A same-named group on a *different* gid would leave
 * `useradd -g <gid>` asking for a group that does not exist, so it fails here
 * with a diagnosis instead of there with a confusing one.
 */
export function planMindGroup(existingGid: number | null, targetGid: number): "skip" | "create" {
  if (existingGid === null) return "create";
  if (existingGid === targetGid) return "skip";
  throw new Error(
    `group already exists on gid ${existingGid}, but the mind's files need gid ${targetGid}`,
  );
}

/** gid of an existing Linux group, or null when there is no such group. */
function linuxGroupGid(group: string): number | null {
  try {
    const gid = parseInt(
      execFileSync("getent", ["group", group], { encoding: "utf-8" }).split(":")[2],
      10,
    );
    return Number.isNaN(gid) ? null : gid;
  } catch {
    return null;
  }
}

/**
 * argv for the Linux `useradd` that creates a mind's user. Pure so the repair
 * path's flags are testable — in particular that a recreated user keeps its
 * membership of the shared `volute` group, whose absence fails later and
 * elsewhere rather than at creation.
 */
export function linuxUseraddArgs(
  user: string,
  homeDir?: string,
  ids?: { uid: number; gid: number | null },
): string[] {
  const args = ["-r", "-M", "-G", "volute", "-s", "/usr/sbin/nologin"];
  if (ids) args.push("-u", String(ids.uid));
  if (ids?.gid != null) args.push("-g", String(ids.gid));
  if (homeDir) args.push("-d", homeDir);
  args.push(user);
  return args;
}

/**
 * Create a system user for a mind. `homeDir` sets the home directory.
 *
 * `ids` pins the numeric uid (and, on Linux, the gid of the mind's own group)
 * instead of allocating fresh ones — used by `ensureMindUser` to recreate a user
 * that vanished from the passwd db while its files kept the old numeric owner.
 */
export function createMindUser(
  name: string,
  homeDir?: string,
  ids?: { uid: number; gid: number | null },
): void {
  if (!isIsolationEnabled()) return;
  const user = mindUserName(name);
  try {
    execFileSync("id", [user], { stdio: "ignore" });
    return; // already exists
  } catch {
    // User doesn't exist — create it
  }

  if (process.platform === "darwin") {
    // macOS group ownership is the shared `volute` group, so only the uid is
    // ever pinned here; the gid comes from the live group either way.
    const uid = macIdToCreate(ids?.uid, macTakenIds("Users"));
    const gid = getVoluteGroupGid();
    const home = homeDir ?? "/var/empty";
    try {
      execFileSync("dscl", [".", "-create", `/Users/${user}`]);
      execFileSync("dscl", [".", "-create", `/Users/${user}`, "UniqueID", String(uid)]);
      execFileSync("dscl", [".", "-create", `/Users/${user}`, "PrimaryGroupID", String(gid)]);
      execFileSync("dscl", [".", "-create", `/Users/${user}`, "UserShell", "/usr/bin/false"]);
      execFileSync("dscl", [".", "-create", `/Users/${user}`, "NFSHomeDirectory", home]);
      execFileSync("dscl", [".", "-create", `/Users/${user}`, "RealName", `Volute Mind: ${name}`]);
      execFileSync("dscl", [".", "-create", `/Users/${user}`, "IsHidden", "1"]);
      execFileSync("dscl", [".", "-append", "/Groups/volute", "GroupMembership", user]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to create user ${user} on macOS: ${msg}`);
    }
    return;
  }

  // Linux
  if (ids?.gid != null) {
    // Recreate the mind's own group on its original gid first, so useradd can
    // attach the user to it (Linux mind dirs are owned <user>:<user>).
    if (planMindGroup(linuxGroupGid(user), ids.gid) === "create") {
      try {
        // Deliberately no `-f`: its second behaviour is to silently allocate a
        // *different* gid when the requested one is taken, which would leave
        // useradd asking for a gid that does not exist. A collision here must
        // fail loudly instead.
        execFileSync("groupadd", ["-g", String(ids.gid), user], {
          stdio: ["ignore", "ignore", "pipe"],
        });
      } catch (err) {
        const stderr = (err as { stderr?: Buffer })?.stderr?.toString().trim();
        throw new Error(`Failed to create group ${user}${stderr ? `: ${stderr}` : ""}`);
      }
    }
  }
  try {
    execFileSync("useradd", linuxUseraddArgs(user, homeDir, ids), {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer })?.stderr?.toString().trim();
    throw new Error(`Failed to create user ${user}${stderr ? `: ${stderr}` : ""}`);
  }
}

/** Delete a mind's system user. */
export function deleteMindUser(name: string): void {
  if (!isIsolationEnabled()) return;
  const user = mindUserName(name);
  knownUsers.delete(user);
  ownerIds.delete(user);

  if (process.platform === "darwin") {
    try {
      execFileSync("dscl", [".", "-delete", `/Users/${user}`], { stdio: "ignore" });
    } catch {
      // User may not exist — ignore
    }
    try {
      execFileSync("dscl", [".", "-delete", "/Groups/volute", "GroupMembership", user], {
        stdio: "ignore",
      });
    } catch {
      // May not be in group — ignore
    }
    return;
  }

  // Linux
  try {
    execFileSync("userdel", [user], { stdio: "ignore" });
  } catch {
    // User may not exist — ignore
  }
}

/** True when a system user with this name exists. */
async function systemUserExists(user: string): Promise<boolean> {
  try {
    await exec("id", [user]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The name of the user holding `uid`, or null when the uid is unassigned. Fails
 * open — a transient `id` failure reads as "unassigned" — so it is not the only
 * guard: creation is backstopped by `useradd`'s "UID is not unique" refusal on
 * Linux and by `macIdToCreate`'s directory-service check on macOS.
 */
async function userNameForUid(uid: number): Promise<string | null> {
  try {
    const name = (await exec("id", ["-un", String(uid)])).trim();
    return name || null;
  } catch {
    return null;
  }
}

/** The name of the group holding `gid`, or null when the gid is unassigned. */
async function groupNameForGid(gid: number): Promise<string | null> {
  try {
    const line = (await exec("getent", ["group", String(gid)])).trim();
    const name = line.split(":")[0];
    return name || null;
  } catch {
    return null;
  }
}

export type UserRepairPlan =
  | { action: "none"; reason: string }
  | { action: "reuse"; uid: number; gid: number | null }
  | { action: "refuse"; reason: string };

/**
 * Decide how to repair a mind whose OS user has gone missing.
 *
 * Pure so the decision is testable without root: creating users isn't.
 *
 * Reusing the uid found on disk is what keeps every existing file readable by
 * the recreated user, and it is the only outcome that repairs anything. That
 * uid is trustworthy because only root can chown a file to an arbitrary uid,
 * and the daemon is the only thing that ever chowns a mind directory — a mind
 * cannot give its own files to a uid it picked. Two cases break that argument:
 *
 * - **uid/gid 0.** Root ownership means the daemon's chown never ran (see the
 *   upgrade-chown bug that left a mind's files root-owned), not that the mind
 *   is root. Reusing it would mint a root-privileged mind user and spawn the
 *   mind as root.
 * - **The id is already taken** by an account that isn't this mind's own.
 *   Recreating the user on a live uid/gid would hand that other account's
 *   identity to the mind, and the mind's files to that account.
 *
 * Both refuse rather than substituting a fresh id. A fresh id would look like a
 * repair and isn't one: in the very scenario this exists for, every mind user
 * is missing at once while their uids still own directories on disk, so
 * `useradd -r` allocating "the next free uid" can hand this mind the uid that
 * still owns a *different* mind's `chmod 700` directory — including its private
 * identity key. Refusing leaves the caller's existing, loud failure in place,
 * which is worse for one mind and safe for the others.
 */
export function planUserRepair(input: {
  /** The mind's OS user name, so its own leftover group can be recognised. */
  user: string;
  userExists: boolean;
  /** uid/gid currently owning the mind's directory; null when it is unreadable. */
  dirOwner: { uid: number; gid: number } | null;
  /** Existing account holding `dirOwner.uid`, if any. */
  uidTakenBy: string | null;
  /** Existing group holding `dirOwner.gid`, if any. Only consulted when `reuseGid`. */
  gidOwner: string | null;
  /** Linux owns mind dirs `<user>:<user>`, so the gid must be reused too. */
  reuseGid: boolean;
}): UserRepairPlan {
  if (input.userExists) return { action: "none", reason: "user already exists" };
  if (!input.dirOwner) {
    return { action: "refuse", reason: "mind directory is missing or unreadable" };
  }

  const { uid, gid } = input.dirOwner;
  if (uid === 0) {
    return { action: "refuse", reason: "mind directory is root-owned (uid 0), refusing to reuse" };
  }
  if (input.uidTakenBy !== null) {
    return { action: "refuse", reason: `uid ${uid} already belongs to ${input.uidTakenBy}` };
  }
  if (!input.reuseGid) return { action: "reuse", uid, gid: null };

  if (gid === 0) {
    return {
      action: "refuse",
      reason: "mind directory is root-grouped (gid 0), refusing to reuse",
    };
  }
  // A group already named after this mind is ours, left over from a repair that
  // created the group and then failed before useradd. It must not block a retry.
  if (input.gidOwner !== null && input.gidOwner !== input.user) {
    return { action: "refuse", reason: `gid ${gid} already belongs to group ${input.gidOwner}` };
  }
  return { action: "reuse", uid, gid };
}

/**
 * The commands a host should run to put a mind back on its feet when the daemon
 * has refused to guess. Both refusals — a root-owned directory, or an id held by
 * someone else — need the same two steps: bring the user back, then hand it the
 * files. Only a human can pick the id safely, which is exactly why this is
 * printed rather than executed.
 */
export function repairRemedy(user: string, dir: string, platform = process.platform): string {
  if (platform === "darwin") {
    return `create ${user} (see \`volute setup\`), then \`chown -R ${user}:volute ${dir}\``;
  }
  return (
    `useradd -r -M -G volute -s /usr/sbin/nologin ${user} && ` +
    `chown -R ${user}:${user} ${dir} && chmod 700 ${dir}`
  );
}

/** The alert kind fanned out when a mind's OS user is missing and unrepairable. */
export const MIND_USER_ALERT_KIND = "mind_user_missing";

/**
 * Minds already alerted about an unrepairable user in this daemon run. A refusal
 * is not memoised — every later call re-probes, so a host's manual fix is picked
 * up without a restart — which means the alert itself has to be rate-limited or a
 * broken mind would fan one out on every exec.
 */
const alertedUsers = new Set<string>();

/**
 * Tell the mind, the spirit, and the dashboard that a mind cannot start because
 * its OS user is gone and the daemon will not guess at a replacement.
 *
 * A log line alone is the wrong channel for this: it is a total outage for one
 * mind, and the host may never read journald. `alertHost` reaches all three, and
 * still does something useful in the degraded case this always hits — the
 * immediate delivery fails when the mind is the one that cannot start, but the
 * spirit notice and the `mind_error` activity row still land.
 */
export async function reportUnrepairable(
  baseName: string,
  user: string,
  dir: string,
  reason: string,
): Promise<void> {
  if (alertedUsers.has(user)) return;
  alertedUsers.add(user);

  const remedy = dir ? ` Fix by hand: ${repairRemedy(user, dir)}` : "";
  ilog.error(`mind ${baseName} cannot start: ${reason}.${remedy}`, { mind: baseName, user, dir });

  try {
    await alertHost(
      baseName,
      MIND_USER_ALERT_KIND,
      `Your operating-system user \`${user}\` is missing, and the daemon could not ` +
        `recreate it safely: ${reason}.\n\nUntil a host fixes this you cannot be ` +
        `started, and anything that hands you ownership of your own files will fail.` +
        (dir ? `\n\nOn the host, with root:\n\n    ${repairRemedy(user, dir)}` : ""),
    );
  } catch (err) {
    ilog.error(`failed to alert about the missing OS user ${user}`, log.errorData(err));
  }
}

/** In-flight repairs, so concurrent first-touches of a mind don't race useradd. */
const repairsInFlight = new Map<string, Promise<void>>();

/**
 * Recreate a mind's OS user when it has gone missing while its files remain.
 *
 * The case this exists for: on Docker, `/data` and `/minds` are named volumes
 * but `/etc/passwd` lives in the container filesystem, so the documented
 * `docker compose pull && docker compose up -d` upgrade — which recreates the
 * container — wipes every `mind-<name>` user while the mind directories keep
 * files owned by the now-nameless uids. Without repair every mind is
 * permanently unstartable and every chown throws `invalid user`.
 *
 * Best-effort by contract: it never throws, and it never invents an identity it
 * isn't sure of. When it can't repair safely the caller's own operation fails
 * exactly as it does today, with its own error, rather than having a real
 * diagnosis replaced by a repair failure.
 */
export async function ensureMindUser(name: string): Promise<void> {
  if (!isIsolationEnabled()) return;
  // Creating users needs root. Under user isolation the daemon is root; when it
  // is not (dev, unit tests), there is nothing this can do, so skip the probes.
  if (process.getuid?.() !== 0) return;

  // Variants run as their parent's OS user — the same resolution wrapForIsolation
  // does. Without it a variant name would look like a mind with no user at all.
  let baseName: string;
  try {
    baseName = await getBaseName(name);
  } catch {
    return; // Registry unreadable — nothing to repair against
  }
  return ensureUserForBaseMind(baseName);
}

/**
 * `ensureMindUser` for a caller that has already resolved the base mind name —
 * `wrapForIsolation` has, and it sits on the hottest isolation path, so it must
 * not pay for a second registry lookup on every exec.
 */
async function ensureUserForBaseMind(baseName: string): Promise<void> {
  let user: string;
  try {
    user = mindUserName(baseName);
  } catch {
    return; // Not a repairable name
  }
  if (knownUsers.has(user)) return;

  const inFlight = repairsInFlight.get(user);
  if (inFlight) return inFlight;
  // The .catch is the structural half of the never-throws contract: repairMindUser
  // handles its own failures, and this guarantees it even if a handler ever doesn't.
  const repair = repairMindUser(baseName, user)
    .catch((err) => ilog.error(`OS user repair for ${baseName} threw`, log.errorData(err)))
    .finally(() => repairsInFlight.delete(user));
  repairsInFlight.set(user, repair);
  return repair;
}

async function repairMindUser(baseName: string, user: string): Promise<void> {
  let dir = "";
  try {
    if (await systemUserExists(user)) {
      knownUsers.add(user);
      return;
    }

    // resolveMindDir, not mindDir: the spirit's directory is not under the
    // minds dir, and only the registry lookup gets it right.
    dir = await resolveMindDir(baseName);
    let dirOwner: { uid: number; gid: number } | null = null;
    if (existsSync(dir)) {
      try {
        const st = statSync(dir);
        dirOwner = { uid: st.uid, gid: st.gid };
      } catch {
        dirOwner = null;
      }
    }

    // Before planning: the shared group must exist, and creating it allocates a
    // gid, which could otherwise invalidate the gid check the plan is built on.
    ensureVoluteGroup();

    const reuseGid = process.platform !== "darwin";
    const plan = planUserRepair({
      user,
      userExists: false,
      dirOwner,
      uidTakenBy: dirOwner ? await userNameForUid(dirOwner.uid) : null,
      gidOwner: dirOwner && reuseGid ? await groupNameForGid(dirOwner.gid) : null,
      reuseGid,
    });

    if (plan.action !== "reuse") {
      await reportUnrepairable(
        baseName,
        user,
        dir,
        `its OS user ${user} is missing and cannot be recreated safely (${plan.reason})`,
      );
      return;
    }

    createMindUser(baseName, resolve(dir, "home"), { uid: plan.uid, gid: plan.gid });
    knownUsers.add(user);
    ilog.warn(`recreated missing OS user ${user}, reusing the ids that own its directory`, {
      mind: baseName,
      uid: plan.uid,
      gid: plan.gid,
      dir,
    });
  } catch (err) {
    // Same stakes as a refusal: the mind cannot start either way.
    ilog.error(`repairing the missing OS user ${user} failed`, {
      mind: baseName,
      dir,
      ...log.errorData(err),
    });
    await reportUnrepairable(
      baseName,
      user,
      dir,
      `recreating its missing OS user ${user} failed (${err instanceof Error ? err.message : err})`,
    );
  }
}

/**
 * git options for an operation that must run as the mind, not as the daemon.
 *
 * Under user isolation the command goes through `gitExec`'s isolation wrapper
 * (runuser/sudo to the mind's uid), so a hook the mind wrote executes with the
 * mind's privilege rather than the daemon's (#871), and HOME points at the mind's
 * own home/. Note the switching tool has the last word on HOME — `sudo`'s env_reset
 * and `runuser` both may set it from the target account — so treat that as a best
 * effort; the load-bearing property here is the env scrub `exec` applies to every
 * child (`util/exec.ts`, #966), which holds either way because env_reset only ever
 * removes variables.
 *
 * Without isolation there is one uid, so there is no uid to switch to and no reason
 * to redirect HOME (doing so would strip `~/.gitconfig` from git's config
 * resolution and break commits in repos with no per-repo identity) — but the
 * environment is still scrubbed, because the hook still runs and the token is still
 * in the daemon's environment.
 */
export function mindGitOpts(
  dir: string,
  mindName: string,
): { cwd: string; mindName?: string; env?: NodeJS.ProcessEnv } {
  if (!isIsolationEnabled()) return { cwd: dir };
  return { cwd: dir, mindName, env: { HOME: resolve(dir, "home") } };
}

/**
 * Wrap a command with user isolation if enabled.
 * macOS: `sudo -E -u <user> --`
 * Linux: `runuser -u <user> --`
 * `-E` is load-bearing: sudo's default `env_reset` would otherwise drop the env the
 * caller built (VOLUTE_HOME, VOLUTE_MIND_TOKEN, credentials, …), and the mind's CLI
 * then reports "Volute is not set up". runuser keeps the environment on its own.
 * Root's `ALL` sudoers entry implies SETENV, so `-E` is permitted.
 * Resolves the base mind name from a potentially composite "name@variant" key.
 */
export async function wrapForIsolation(
  cmd: string,
  args: string[],
  mindName: string,
): Promise<[string, string[]]> {
  if (!isIsolationEnabled()) return [cmd, args];
  const baseName = await getBaseName(mindName);
  await ensureUserForBaseMind(baseName);
  const user = mindUserName(baseName);
  if (process.platform === "darwin") {
    return ["sudo", ["-E", "-u", user, "--", cmd, ...args]];
  }
  return ["runuser", ["-u", user, "--", cmd, ...args]];
}

/** Resolve a user's numeric uid via `id -u`, or null if the lookup fails. */
async function userUid(user: string): Promise<number | null> {
  try {
    const uid = parseInt((await exec("id", ["-u", user])).trim(), 10);
    return Number.isNaN(uid) ? null : uid;
  } catch {
    return null;
  }
}

/** Resolve a group's numeric gid, or null if the lookup fails. */
async function groupGid(group: string): Promise<number | null> {
  try {
    if (process.platform === "darwin") {
      const output = await exec("dscl", [".", "-read", `/Groups/${group}`, "PrimaryGroupID"]);
      const match = output.match(/PrimaryGroupID:\s*(\d+)/);
      return match ? parseInt(match[1], 10) : null;
    }
    const gid = parseInt((await exec("getent", ["group", group])).split(":")[2], 10);
    return Number.isNaN(gid) ? null : gid;
  } catch {
    return null;
  }
}

/**
 * Numeric ids for `user:group` — the same group name the recursive chown uses,
 * so the root and the tree under it can't end up in different groups.
 */
async function mindOwnerIds(user: string, group: string): Promise<{ uid: number; gid: number }> {
  const cached = ownerIds.get(user);
  if (cached) return cached;
  const [uid, gid] = await Promise.all([userUid(user), groupGid(group)]);
  if (uid === null || gid === null) {
    throw new Error(`Failed to chown to ${user}:${group}: could not resolve their numeric ids`);
  }
  const ids = { uid, gid };
  ownerIds.set(user, ids);
  return ids;
}

/** The `user:group` a mind's files belong to under isolation. */
function mindOwnerNames(name: string): { user: string; group: string } {
  const user = mindUserName(name);
  return { user, group: process.platform === "darwin" ? "volute" : user };
}

/**
 * Numeric owner of a mind's files — what chownMindDir/chownMindFile set, and what
 * `writeMindFile` sets on its open handle — or null when isolation is off and the
 * daemon's own ownership is already right.
 */
export async function mindFileOwner(name: string): Promise<{ uid: number; gid: number } | null> {
  if (!isIsolationEnabled()) return null;
  await ensureMindUser(name);
  const { user, group } = mindOwnerNames(name);
  return mindOwnerIds(user, group);
}

/**
 * Resolve `path` for a chown the daemon runs as root, refusing one a mind has
 * steered out of its own tree.
 *
 * O_NOFOLLOW only guards a path's last component. A mind can rearrange anything
 * inside a directory it owns — `mv home home.bak && ln -s /root home` — so a
 * path like `<mind>/home/.claude` can resolve to `/root/.claude` with no symlink
 * at the end. The part of a path the mind can't touch is everything above the
 * topmost component it owns (`mindOwns`, by the lstat'd owner): nothing it
 * creates can land in a directory it does not own. That component is the base,
 * and the path's real location must stay inside the base's. With no mind-owned
 * component (a tree not handed over yet) there is nothing to contain.
 *
 * Returns the real path, which callers act on so the check and the act agree
 * about which tree they mean. What is left is a race: a mind swapping a
 * directory below the base for a link between this resolve and the chown. That
 * window is much narrower than a planted link, and closing it needs an
 * openat-style walk Node does not offer.
 */
export async function containMindPath(
  path: string,
  mindOwns: (st: Stats) => boolean,
): Promise<string> {
  const abs = resolve(path);
  const ancestors: string[] = [];
  for (let p = abs; ; p = dirname(p)) {
    ancestors.unshift(p);
    if (dirname(p) === p) break;
  }
  for (const p of ancestors) {
    const st = await lstat(p);
    if (!mindOwns(st)) continue;
    if (st.isSymbolicLink()) throw new Error(`${p} is a symlink the mind owns`);
    return resolveRealWithinBase(p, relative(p, abs));
  }
  return abs;
}

/** True if `path` is already owned by `uid`. */
function ownedBy(path: string, uid: number): boolean {
  try {
    return statSync(path).uid === uid;
  } catch {
    return false;
  }
}

/**
 * Whether `chownMindDir` may leave a full mind project's node_modules out of its
 * walk. node_modules dominates the tree; when it's already owned by the mind user
 * (a re-run), walking it is tens of thousands of needless stats. "Owned" is judged
 * by the node_modules inode alone — a heuristic, and one a root-run npm defeats:
 * it adds root-owned packages under a mind-owned node_modules (#1231). npm itself
 * runs as the mind, so `npmInstallAsMind` reclaims the tree it is about to change
 * with `reclaimNodeModules` rather than trusting this. Every other top-level entry
 * (home/, .mind/, .git/, src/, package.json, …) is still walked — root-driven
 * flows like merge/upgrade write into .git as root, and those paths must be
 * re-chowned or the mind's own auto-commit later hits EACCES.
 */
export async function skipNodeModules(dir: string, user: string): Promise<boolean> {
  const nodeModules = resolve(dir, "node_modules");
  if (!existsSync(nodeModules) || !existsSync(resolve(dir, "home"))) return false;
  const uid = await userUid(user);
  return uid !== null && ownedBy(nodeModules, uid);
}

/**
 * Set ownership of a mind directory to its system user. Async so the recursive
 * chown never blocks the daemon event loop (these run from request handlers).
 */
export async function chownMindDir(dir: string, name: string): Promise<void> {
  const ids = await mindFileOwner(name);
  if (!ids) return;
  const { user, group } = mindOwnerNames(name);
  let root: string;
  try {
    // Contained before anything is chowned or listed: callers hand us paths a
    // mind can redirect (credential-sync passes `home/.claude`). That covers the
    // components above the root; below it is chownBelow's.
    root = await containMindPath(dir, (st) => st.uid === ids.uid);
  } catch (err) {
    throw new Error(
      `Failed to chown ${dir} to ${user}:${group}: ${err instanceof Error ? err.message : err}`,
    );
  }
  let skipped: string[];
  try {
    const prune = (await skipNodeModules(root, user)) ? ["node_modules"] : [];
    skipped = await chownBelow(root, { user, group }, { prune });
  } catch (err) {
    const stderr = String((err as { stderr?: string })?.stderr ?? "").trim();
    throw new Error(`Failed to chown ${root} to ${user}:${group}${stderr ? `: ${stderr}` : ""}`);
  }
  // The root last, through a handle, never a path: the mind may own the root's
  // parent (credential-sync hands us `home/.claude`) and swap the root for a
  // symlink, which the handle refuses.
  try {
    await chownNoFollow(root, ids.uid, ids.gid, "dir");
  } catch (err) {
    throw new Error(
      `Failed to chown ${root} to ${user}:${group}: ${err instanceof Error ? err.message : err}`,
    );
  }
  // A log line, not an alert: nothing here needs the host to act, and a mind's
  // own hard links (already its own) never land in this list.
  if (skipped.length > 0) {
    ilog.warn("left hard-linked files out of a mind's chown", {
      mind: name,
      dir: root,
      count: skipped.length,
      paths: skipped.slice(0, 20),
    });
  }
  await lockPrivateSubtrees(root);
}

/** Marks a failed chown in `chownForeignOwned`'s find output. */
const CHOWN_FAILED = "volute-chown-failed:";

/**
 * chown to `owner` everything under `root`, itself included, that is not owned
 * by `uid`, in a single `find` pass, returning the paths it handed over.
 *
 * Nothing is looked up by path twice. The walk is physical (`find` defaults to
 * -P, so a planted symlink is never descended), and each chown runs via
 * -execdir on `./<name>` from inside the directory the walk is already in, with
 * -h so a symlink entry is re-owned itself rather than its target. A separate
 * `chown -R <path>` after a walk would resolve the whole path again — and a
 * mind that owns a directory above it could swap that directory for a link to,
 * say, Volute's own install in the meantime.
 *
 * Regular files with more than one link are skipped: a mind can hard-link a
 * root-owned file (`/etc/sudoers`) into its own tree wherever the kernel allows
 * it (macOS always; Linux with fs.protected_hardlinks=0), and re-owning the
 * link re-owns the file. npm never hard-links into node_modules.
 *
 * One chown per entry (`;`, not `+`): a batched chown runs long after find
 * tested the entry, and the mind — which owns node_modules — could rename a
 * root-owned entry away and put a hard link to a root-owned file under its name
 * in between. Per entry the window is the stat→chown gap alone; it stays, since
 * closing it needs an fd-based walk Node and find do not offer (#1235). Healthy
 * trees match nothing and so spawn nothing.
 *
 * A failing `find` or chown throws — it never falls back to something broader.
 */
export async function chownForeignOwned(
  root: string,
  uid: number,
  owner: { spec: string; uid: number; gid: number },
): Promise<string[]> {
  // The root through a handle: BSD find's -execdir mis-resolves the starting
  // point itself (it runs from the wrong directory), so the walk starts below it.
  const reclaimed: string[] = [];
  if ((await lstat(root)).uid !== uid) {
    await chownNoFollow(root, owner.uid, owner.gid, "dir");
    reclaimed.push(root);
  }
  const out = await exec("find", [
    root,
    "-mindepth",
    "1",
    "!",
    "-uid",
    String(uid),
    "(",
    "-type",
    "d",
    "-o",
    "-links",
    "1",
    ")",
    "(",
    "-execdir",
    "chown",
    "-h",
    owner.spec,
    "{}",
    ";",
    "-print",
    "-o",
    "-exec",
    "echo",
    CHOWN_FAILED,
    "{}",
    ";",
    ")",
  ]);
  const lines = out.split("\n").filter(Boolean);
  // `-execdir … ;` reports a failed chown as a false test, not in find's exit
  // status, so failures are printed as their own lines and raised here.
  const failed = lines.filter((l) => l.startsWith(CHOWN_FAILED));
  if (failed.length > 0) {
    throw new Error(`chown failed for ${failed.map((l) => l.slice(CHOWN_FAILED.length + 1))}`);
  }
  return [...reclaimed, ...lines];
}

/**
 * Hand a mind's `node_modules` back to the mind before npm runs as it (#1231).
 *
 * Skill installs ran npm as root until #1222, which left root-owned packages
 * (libsql and its dependencies) under a node_modules the mind otherwise owns.
 * npm-as-the-mind fails with EACCES on any install that must change them, and
 * `chownMindDir` never reached them — see `skipNodeModules`. The spirit's sync
 * still runs npm as root, so the residue can come back; hence a pass before
 * every install rather than a one-time migration.
 *
 * On a healthy tree that pass is a metadata-only walk that re-owns nothing, so
 * no inode is rewritten. The root is contained as in `chownMindDir`; below it,
 * see `chownForeignOwned`. No-op when isolation is off or there is no
 * node_modules.
 */
export function reclaimNodeModules(dir: string, mindName: string): Promise<void> {
  return reclaimMindSubtree(dir, "node_modules", mindName);
}

/**
 * Hand a mind's `.git` back to the mind before git runs as it (#1310). Skills git runs as
 * the mind (#1284), and one root-owned directory under `.git/objects` — left by git a
 * daemon ran as root before then — fails the first object the mind writes into it.
 * Same walk as {@link reclaimNodeModules}. A variant worktree's `.git` is a file naming
 * the parent's git dir — a path the mind wrote, so never one to chown; this leaves it.
 */
export function reclaimMindGit(dir: string, mindName: string): Promise<void> {
  return reclaimMindSubtree(dir, ".git", mindName);
}

/** A directory `rel` under `dir`, handed to the mind; anything else there is left alone. */
async function reclaimMindSubtree(dir: string, rel: string, mindName: string): Promise<void> {
  if (!isIsolationEnabled()) return;
  const subtree = resolve(dir, rel);
  try {
    if (!(await lstat(subtree)).isDirectory()) return;
  } catch {
    return;
  }
  const baseName = await getBaseName(mindName);
  const { user, group } = mindOwnerNames(baseName);
  try {
    const ids = await mindFileOwner(baseName);
    if (!ids) return;
    const root = await containMindPath(subtree, (st) => st.uid === ids.uid);
    const reclaimed = await chownForeignOwned(root, ids.uid, { spec: `${user}:${group}`, ...ids });
    if (reclaimed.length > 0) {
      ilog.info(`reclaimed root-owned ${rel} entries for the mind`, {
        dir: root,
        mind: baseName,
        count: reclaimed.length,
      });
    }
  } catch (err) {
    const stderr = String((err as { stderr?: string })?.stderr ?? "").trim();
    throw new Error(
      `Failed to reclaim ${subtree} for ${user}:${group}: ${stderr || (err instanceof Error ? err.message : err)}`,
    );
  }
}

/**
 * Directories under a mind's project root that hold only the mind's own record
 * of itself: its session transcripts under `home/.claude/projects`, and its
 * runtime state (identity keypair, session cursors, per-template session dirs)
 * under `.mind`. Relative to `dir`, so a call that passes a subtree directly
 * (credential-sync hands us `home/.claude`) finds none of them and locks that
 * dir alone.
 */
const PRIVATE_SUBTREES = ["home/.claude", "home/.claude/projects", ".mind"];

/**
 * chmod 0700 the directory at `target`, refusing to follow a symlink.
 *
 * Opens with O_NOFOLLOW|O_DIRECTORY and sets the mode on the handle rather than
 * shelling out to `chmod` on a path. The distinction is load-bearing, not
 * stylistic: a mind owns these directories and runs concurrently with every
 * caller, so any check-then-act on a path can be raced — swap the directory for
 * a symlink in the window between the check and the chmod and the daemon, which
 * is root, follows it. `ln -s /etc .mind` would then land `chmod 700 /etc` and
 * take the host down. Opening refuses the symlink outright (ELOOP) and the mode
 * lands on the inode that was opened, so there is no window to win.
 *
 * Throws the raw errno error: ELOOP (a symlink), ENOTDIR (a file), ENOENT (gone).
 */
async function chmodDirNoFollow(target: string): Promise<void> {
  await withNoFollowHandle(target, constants.O_DIRECTORY, (handle) => handle.chmod(0o700));
}

/**
 * Open `target` read-only without following a final symlink, run `fn` on the
 * handle, and close it. O_NONBLOCK is for opens without O_DIRECTORY: a plain
 * read-only open of a FIFO a mind planted at `target` would otherwise wait for a
 * writer that never comes, hanging the caller. With O_DIRECTORY it is inert.
 */
async function withNoFollowHandle(
  target: string,
  flags: number,
  fn: (handle: FileHandle) => Promise<void>,
): Promise<void> {
  const handle = await open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | flags,
  );
  try {
    await fn(handle);
  } finally {
    await handle.close();
  }
}

/**
 * chown the directory (`kind: "dir"`) or file at `target` to `uid:gid`, refusing
 * to follow a final symlink — the ownership counterpart to `chmodDirNoFollow`,
 * for the same reason: the owner lands on the inode that was opened, so a mind
 * swapping the path for a link can't redirect it. Pair it with
 * `containMindPath` for the components above.
 *
 * A file with a second name is refused (EMLINK) the same way: a hard link is the
 * file itself, so re-owning a planted `ln /etc/sudoers x` hands over sudoers
 * (#1235). The link count comes from the open handle, so the check and the chown
 * see the same inode.
 *
 * Throws the raw errno error: ELOOP (a symlink; macOS reports ENOTDIR for a
 * symlink opened as "dir"), ENOTDIR (not a directory), ENOENT (gone), EMLINK
 * (a hard-linked file).
 */
export async function chownNoFollow(
  target: string,
  uid: number,
  gid: number,
  kind: "dir" | "file",
): Promise<void> {
  await withNoFollowHandle(target, kind === "dir" ? constants.O_DIRECTORY : 0, async (handle) => {
    const st = await handle.stat();
    if (!st.isDirectory() && st.nlink > 1) {
      throw Object.assign(new Error(`EMLINK: ${target} has ${st.nlink} links, refusing to chown`), {
        code: "EMLINK",
      });
    }
    await handle.chown(uid, gid);
  });
}

/** True for the errnos that mean "there is no directory of ours here to lock". */
function isRefusal(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ELOOP" || code === "ENOTDIR";
}

/**
 * Lock a mind's directory and its private subtrees to 0700.
 *
 * The project root's own 700 is the load-bearing gate and still is. But the
 * daemon only ever chmod'ed that one inode, so a directory created later inside
 * the tree by the mind's own processes lands at whatever their umask gives —
 * `home/.claude/projects`, which the Agent SDK creates on its first session,
 * has been found at 755 on a real host. A mind's session transcripts are its own
 * inner record; every other mind-owned directory is 700 and these should be too,
 * rather than resting on a single ancestor's mode.
 *
 * Directory-level only: files inside keep the mode their writer gave them, since
 * the gate being fixed is the directory one. Returns the paths it locked; absent
 * ones are skipped, never created.
 *
 * Every target sits inside a tree the mind itself owns and can rearrange at any
 * moment, so nothing here trusts a path: subtrees are contained with
 * `resolveRealWithinBase` and every mode is set through an O_NOFOLLOW handle.
 * Not gated on isolation; callers gate.
 */
export async function lockPrivateSubtrees(dir: string): Promise<string[]> {
  try {
    await chmodDirNoFollow(dir);
  } catch (err) {
    // A root that is a symlink or a file is a refusal, not a failure — and the
    // subtrees below are never resolved through a root we would not lock.
    if (isRefusal(err)) {
      ilog.warn("refusing to lock a path that is not a real directory", {
        dir,
        ...log.errorData(err),
      });
      return [];
    }
    throw new Error(`Failed to chmod ${dir}: ${err instanceof Error ? err.message : err}`);
  }
  const locked = [dir];
  for (const sub of PRIVATE_SUBTREES) {
    let target: string;
    try {
      // Containment on every component, not just the last one: a mind that swaps
      // `home/` for a link to another mind's home would otherwise steer this
      // outside its own directory. O_NOFOLLOW covers the final component against
      // a concurrent swap; an intermediate component re-pointed between this
      // resolve and the open stays a (much narrower) window.
      target = await resolveRealWithinBase(dir, sub);
    } catch (err) {
      // Absent is the ordinary case — there is no projects/ before the first
      // session, and none of these exist when a mind is created.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        ilog.warn("refusing to lock a subtree that leaves the mind's directory", {
          dir,
          sub,
          ...log.errorData(err),
        });
      }
      continue;
    }
    try {
      await chmodDirNoFollow(target);
      locked.push(target);
    } catch (err) {
      // Gone between the resolve and the open is ordinary: the mind is running.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      if (isRefusal(err)) {
        ilog.warn("refusing to lock a path that is not a real directory", {
          target,
          ...log.errorData(err),
        });
        continue;
      }
      // A subtree lock is defense in depth behind a root gate that already held.
      // Failing a mind's upgrade over one would hand it a way to break its own
      // maintenance, so this warns where the root's failure throws.
      ilog.warn("failed to lock a private subtree", { target, ...log.errorData(err) });
    }
  }
  return locked;
}

/**
 * Set ownership of a single file the daemon wrote into a mind's dir to that
 * mind's system user. Targeted counterpart to chownMindDir — used when the
 * daemon drops one file (e.g. a generated image) into home/ and must hand it to
 * the mind without re-chowning the whole tree. No-op when isolation is off.
 */
export async function chownMindFile(filePath: string, name: string): Promise<void> {
  const ids = await mindFileOwner(name);
  if (!ids) return;
  const { user, group } = mindOwnerNames(name);
  try {
    // Same containment and no-follow as chownMindDir's root: the file sits in a
    // tree the mind can rearrange, and a bare `chown` as root follows a link.
    const target = await containMindPath(filePath, (st) => st.uid === ids.uid);
    await chownNoFollow(target, ids.uid, ids.gid, "file");
  } catch (err) {
    throw new Error(
      `Failed to chown ${filePath} to ${user}:${group}: ${err instanceof Error ? err.message : err}`,
    );
  }
}
