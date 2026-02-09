import { execFileSync } from "node:child_process";

/** Returns true when per-agent Linux user isolation is enabled. */
export function isIsolationEnabled(): boolean {
  return process.env.VOLUTE_ISOLATION === "user";
}

/** Linux username for an agent. */
export function agentUserName(agentName: string): string {
  return `volute-${agentName}`;
}

/** Create the shared `volute` group (idempotent). */
export function ensureVoluteGroup(): void {
  if (!isIsolationEnabled()) return;
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
    execFileSync("useradd", ["-r", "-M", "-g", "volute", "-s", "/usr/sbin/nologin", user], {
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
export function getAgentUserIds(name: string): { uid: number; gid: number } {
  const user = agentUserName(name);
  const uid = parseInt(execFileSync("id", ["-u", user], { encoding: "utf-8" }).trim(), 10);
  const gid = parseInt(execFileSync("id", ["-g", user], { encoding: "utf-8" }).trim(), 10);
  return { uid, gid };
}

/** Set ownership of an agent directory to its system user. */
export function chownAgentDir(dir: string, name: string): void {
  if (!isIsolationEnabled()) return;
  const user = agentUserName(name);
  execFileSync("chown", ["-R", `${user}:volute`, dir]);
  execFileSync("chmod", ["700", dir]);
}
