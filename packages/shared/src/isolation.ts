import { execFileSync } from "node:child_process";
import { validateMindName } from "./registry.js";

/** Returns true when per-mind Linux user isolation is enabled. */
export function isIsolationEnabled(): boolean {
  return process.env.VOLUTE_ISOLATION === "user";
}

/** Linux username for a mind. Prefix configurable via VOLUTE_USER_PREFIX (default: "mind-"). */
export function mindUserName(mindName: string): string {
  const err = validateMindName(mindName);
  if (err) throw new Error(`Invalid mind name for isolation: ${err}`);
  const prefix = process.env.VOLUTE_USER_PREFIX ?? "mind-";
  return `${prefix}${mindName}`;
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

/** Create a system user for a mind. `homeDir` sets the passwd home directory. */
export function createMindUser(name: string, homeDir?: string): void {
  if (!isIsolationEnabled()) return;
  const user = mindUserName(name);
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

/** Delete a mind's system user. */
export function deleteMindUser(name: string): void {
  if (!isIsolationEnabled()) return;
  const user = mindUserName(name);
  try {
    execFileSync("userdel", [user], { stdio: "ignore" });
  } catch {
    // User may not exist — ignore
  }
}

/**
 * Wrap a command with `runuser -u <user> --` if isolation is enabled.
 * Unlike Node's uid/gid spawn options, runuser calls initgroups() which sets
 * supplementary groups, allowing minds to access group-writable shared directories.
 * Resolves the base mind name from a potentially composite "name@variant" key.
 */
export function wrapForIsolation(
  cmd: string,
  args: string[],
  mindName: string,
): [string, string[]] {
  if (!isIsolationEnabled()) return [cmd, args];
  const baseName = mindName.split("@", 2)[0];
  const user = mindUserName(baseName);
  return ["runuser", ["-u", user, "--", cmd, ...args]];
}

/** Set ownership of a mind directory to its system user. */
export function chownMindDir(dir: string, name: string): void {
  if (!isIsolationEnabled()) return;
  const user = mindUserName(name);
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
