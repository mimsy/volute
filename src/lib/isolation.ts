import { execFileSync } from "node:child_process";
import { validateAgentName } from "./registry.js";

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
      execFileSync("groupadd", ["volute"], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (err) {
      const stderr = (err as { stderr?: Buffer })?.stderr?.toString().trim();
      throw new Error(`Failed to create volute group${stderr ? `: ${stderr}` : ""}`);
    }
  }
}

/** Create a system user for an agent. `homeDir` sets the passwd home directory. */
export function createAgentUser(name: string, homeDir?: string): void {
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
    const args = ["-r", "-M", "-G", "volute", "-s", "/usr/sbin/nologin"];
    if (homeDir) args.push("-d", homeDir);
    args.push(user);
    execFileSync("useradd", args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer })?.stderr?.toString().trim();
    throw new Error(`Failed to create user ${user}${stderr ? `: ${stderr}` : ""}`);
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

/**
 * Wrap a command with `runuser -u <user> --` if isolation is enabled.
 * Unlike Node's uid/gid spawn options, runuser calls initgroups() which sets
 * supplementary groups, allowing agents to access group-writable shared directories.
 * Resolves the base agent name from a potentially composite "name@variant" key.
 */
export function wrapForIsolation(
  cmd: string,
  args: string[],
  agentName: string,
): [string, string[]] {
  if (!isIsolationEnabled()) return [cmd, args];
  const baseName = agentName.split("@", 2)[0];
  const user = agentUserName(baseName);
  return ["runuser", ["-u", user, "--", cmd, ...args]];
}

/** Set ownership of an agent directory to its system user. */
export function chownAgentDir(dir: string, name: string): void {
  if (!isIsolationEnabled()) return;
  const user = agentUserName(name);
  try {
    execFileSync("chown", ["-R", `${user}:${user}`, dir], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer })?.stderr?.toString().trim();
    throw new Error(`Failed to chown ${dir} to ${user}${stderr ? `: ${stderr}` : ""}`);
  }
  try {
    execFileSync("chmod", ["700", dir], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer })?.stderr?.toString().trim();
    throw new Error(`Failed to chmod ${dir}${stderr ? `: ${stderr}` : ""}`);
  }
}
