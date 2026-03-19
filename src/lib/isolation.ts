import { execFileSync } from "node:child_process";
import { getBaseName, validateMindName } from "./registry.js";

/** Returns true when per-mind user isolation is enabled. */
export function isIsolationEnabled(): boolean {
  return process.env.VOLUTE_ISOLATION === "user";
}

/** Username for a mind. Prefix configurable via VOLUTE_USER_PREFIX (default: "mind-"). */
export function mindUserName(mindName: string): string {
  const err = validateMindName(mindName);
  // Allow reserved names (e.g. "volute" spirit) — they get the prefix too (mind-volute)
  if (err && !err.includes("reserved")) {
    throw new Error(`Invalid mind name for isolation: ${err}`);
  }
  const prefix = process.env.VOLUTE_USER_PREFIX ?? "mind-";
  return `${prefix}${mindName}`;
}

/** Find next available UID/GID above 400 on macOS. */
function findNextMacId(type: "Users" | "Groups"): number {
  const idField = type === "Users" ? "UniqueID" : "PrimaryGroupID";
  let output: string;
  try {
    output = execFileSync("dscl", [".", "-list", `/${type}`, idField], { encoding: "utf-8" });
  } catch (err) {
    throw new Error(
      `Failed to query ${type} via dscl: ${err instanceof Error ? err.message : err}`,
    );
  }
  const ids = new Set<number>();
  for (const line of output.split("\n")) {
    const parts = line.trim().split(/\s+/);
    const id = parseInt(parts[parts.length - 1], 10);
    if (!Number.isNaN(id)) ids.add(id);
  }
  let next = 401;
  while (ids.has(next)) next++;
  return next;
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

/** Create a system user for a mind. `homeDir` sets the home directory. */
export function createMindUser(name: string, homeDir?: string): void {
  if (!isIsolationEnabled()) return;
  const user = mindUserName(name);
  try {
    execFileSync("id", [user], { stdio: "ignore" });
    return; // already exists
  } catch {
    // User doesn't exist — create it
  }

  if (process.platform === "darwin") {
    const uid = findNextMacId("Users");
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
  const user = mindUserName(baseName);
  if (process.platform === "darwin") {
    return ["sudo", ["-u", user, "--", cmd, ...args]];
  }
  return ["runuser", ["-u", user, "--", cmd, ...args]];
}

/** Set ownership of a mind directory to its system user. */
export function chownMindDir(dir: string, name: string): void {
  if (!isIsolationEnabled()) return;
  const user = mindUserName(name);
  const group = process.platform === "darwin" ? "volute" : user;
  try {
    execFileSync("chown", ["-R", `${user}:${group}`, dir], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer })?.stderr?.toString().trim();
    throw new Error(`Failed to chown ${dir} to ${user}:${group}${stderr ? `: ${stderr}` : ""}`);
  }
  try {
    execFileSync("chmod", ["700", dir], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer })?.stderr?.toString().trim();
    throw new Error(`Failed to chmod ${dir}${stderr ? `: ${stderr}` : ""}`);
  }
}
