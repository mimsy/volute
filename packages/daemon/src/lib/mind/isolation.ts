import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { alertHost } from "../chat/system-events.js";
import { exec } from "../util/exec.js";
import log from "../util/logger.js";
import { getBaseName, isSpiritName, resolveMindDir, validateMindName } from "./registry.js";

const ilog = log.child("isolation");

/**
 * Users this process has confirmed exist. Populated on a successful `id` lookup
 * or a successful repair, and evicted by `deleteMindUser`, so the existence
 * check costs one subprocess per mind per daemon lifetime rather than one per
 * exec.
 */
const knownUsers = new Set<string>();

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
 * Wrap a command with user isolation if enabled.
 * macOS: `sudo -u <user> --`
 * Linux: `runuser -u <user> --`
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
    return ["sudo", ["-u", user, "--", cmd, ...args]];
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

/** True if `path` is already owned by `uid`. */
function ownedBy(path: string, uid: number): boolean {
  try {
    return statSync(path).uid === uid;
  } catch {
    return false;
  }
}

/**
 * Decide which paths `chownMindDir` should recurse. For a full mind project dir,
 * node_modules dominates the tree; when it's already owned by the mind user (a
 * re-run), recursing the whole project needlessly walks tens of thousands of
 * files. In that case we skip node_modules but still recurse every other
 * top-level entry (home/, .mind/, .git/, src/, package.json, …) — root-driven
 * flows like merge/upgrade write into .git as root, and those paths must be
 * re-chowned or the mind's own auto-commit later hits EACCES. Anything else (a
 * state/tmp/credential dir with no node_modules) is recursed whole.
 */
export async function chownTargets(dir: string, user: string): Promise<string[]> {
  const nodeModules = resolve(dir, "node_modules");
  const home = resolve(dir, "home");
  if (existsSync(nodeModules) && existsSync(home)) {
    const uid = await userUid(user);
    if (uid !== null && ownedBy(nodeModules, uid)) {
      return readdirSync(dir)
        .filter((entry) => entry !== "node_modules")
        .map((entry) => resolve(dir, entry));
    }
  }
  return [dir];
}

/**
 * Set ownership of a mind directory to its system user. Async so the recursive
 * chown never blocks the daemon event loop (these run from request handlers).
 */
export async function chownMindDir(dir: string, name: string): Promise<void> {
  if (!isIsolationEnabled()) return;
  await ensureMindUser(name);
  const user = mindUserName(name);
  const group = process.platform === "darwin" ? "volute" : user;
  for (const target of await chownTargets(dir, user)) {
    try {
      await exec("chown", ["-R", `${user}:${group}`, target]);
    } catch (err) {
      const stderr = String((err as { stderr?: string })?.stderr ?? "").trim();
      throw new Error(
        `Failed to chown ${target} to ${user}:${group}${stderr ? `: ${stderr}` : ""}`,
      );
    }
  }
  // The narrowed target list above chowns dir's children, not dir itself, so
  // set the project root inode's owner non-recursively (a no-op when the loop
  // already recursed dir directly).
  try {
    await exec("chown", [`${user}:${group}`, dir]);
  } catch (err) {
    const stderr = String((err as { stderr?: string })?.stderr ?? "").trim();
    throw new Error(`Failed to chown ${dir} to ${user}:${group}${stderr ? `: ${stderr}` : ""}`);
  }
  try {
    await exec("chmod", ["700", dir]);
  } catch (err) {
    const stderr = String((err as { stderr?: string })?.stderr ?? "").trim();
    throw new Error(`Failed to chmod ${dir}${stderr ? `: ${stderr}` : ""}`);
  }
}

/**
 * Set ownership of a single file the daemon wrote into a mind's dir to that
 * mind's system user. Targeted counterpart to chownMindDir — used when the
 * daemon drops one file (e.g. a generated image) into home/ and must hand it to
 * the mind without re-chowning the whole tree. No-op when isolation is off.
 */
export async function chownMindFile(filePath: string, name: string): Promise<void> {
  if (!isIsolationEnabled()) return;
  await ensureMindUser(name);
  const user = mindUserName(name);
  const group = process.platform === "darwin" ? "volute" : user;
  try {
    await exec("chown", [`${user}:${group}`, filePath]);
  } catch (err) {
    const stderr = String((err as { stderr?: string })?.stderr ?? "").trim();
    throw new Error(
      `Failed to chown ${filePath} to ${user}:${group}${stderr ? `: ${stderr}` : ""}`,
    );
  }
}
