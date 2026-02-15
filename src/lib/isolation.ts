import { execFile, execFileSync, type SpawnOptions } from "node:child_process";
import { promisify } from "node:util";
import { validateAgentName } from "./registry.js";

const execFileAsync = promisify(execFile);

/** Returns true when per-agent Linux user isolation is enabled. */
export function isIsolationEnabled(): boolean {
  return process.env.VOLUTE_ISOLATION === "user";
}

/** Linux username for an agent. Prefix configurable via VOLUTE_USER_PREFIX (default: "volute-"). */
export function agentUserName(agentName: string): string {
  const err = validateAgentName(agentName);
  if (err) throw new Error(`Invalid agent name for isolation: ${err}`);
  const prefix = process.env.VOLUTE_USER_PREFIX ?? "agent-";
  return `${prefix}${agentName}`;
}

/** Create the shared `volute` group (idempotent). Pass `force: true` to skip the isolation env check. */
export function ensureVoluteGroup(opts?: { force?: boolean }): void {
  if (!opts?.force && !isIsolationEnabled()) return;
  try {
    execFileSync("getent", ["group", "volute"], { stdio: "ignore" });
  } catch {
    try {
      execFileSync("groupadd", ["volute"], { stdio: "ignore" });
    } catch (err) {
      throw new Error(`Failed to create volute group: ${err}`);
    }
  }
}

/** Create a system user for an agent. */
export function createAgentUser(name: string): void {
  if (!isIsolationEnabled()) return;
  const user = agentUserName(name);
  try {
    // Check if user already exists
    execFileSync("id", [user], { stdio: "ignore" });
    return; // already exists
  } catch {
    // User doesn't exist — create it
  }
  try {
    execFileSync("useradd", ["-r", "-M", "-G", "volute", "-s", "/usr/sbin/nologin", user], {
      stdio: "ignore",
    });
  } catch (err) {
    throw new Error(`Failed to create user ${user}: ${err}`);
  }
}

/** Delete an agent's system user. */
export function deleteAgentUser(name: string): void {
  if (!isIsolationEnabled()) return;
  const user = agentUserName(name);
  try {
    execFileSync("userdel", [user], { stdio: "ignore" });
  } catch {
    // User may not exist — ignore
  }
}

/** Get uid and gid for an agent's system user. */
export async function getAgentUserIds(name: string): Promise<{ uid: number; gid: number }> {
  const user = agentUserName(name);
  const { stdout: uidStr } = await execFileAsync("id", ["-u", user]);
  const { stdout: gidStr } = await execFileAsync("id", ["-g", user]);
  return { uid: parseInt(uidStr.trim(), 10), gid: parseInt(gidStr.trim(), 10) };
}

/**
 * Apply isolation uid/gid to spawn options if isolation is enabled.
 * Resolves the base agent name from a potentially composite "name@variant" key.
 */
export async function applyIsolation(spawnOpts: SpawnOptions, agentName: string): Promise<void> {
  if (!isIsolationEnabled()) return;
  const baseName = agentName.split("@", 2)[0];
  const { uid, gid } = await getAgentUserIds(baseName);
  spawnOpts.uid = uid;
  spawnOpts.gid = gid;
}

/** Set ownership of an agent directory to its system user. */
export function chownAgentDir(dir: string, name: string): void {
  if (!isIsolationEnabled()) return;
  const user = agentUserName(name);
  execFileSync("chown", ["-R", `${user}:${user}`, dir]);
  execFileSync("chmod", ["700", dir]);
}
