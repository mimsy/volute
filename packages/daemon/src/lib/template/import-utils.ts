import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { setBridgeConfig } from "../bridges/bridges.js";
import { readEnv, sharedEnvPath, writeEnv } from "../config/env.js";

/** Find the most recent OpenClaw session whose cwd matches the workspace being imported. */
export function findOpenClawSession(workspaceDir: string): string | undefined {
  const ocAgentsDir = resolve(homedir(), ".openclaw/agents");
  if (!existsSync(ocAgentsDir)) return undefined;

  // Scan all session JSONL files across all OpenClaw agents, match by workspace cwd
  const matches: { path: string; mtime: number }[] = [];
  try {
    for (const entry of readdirSync(ocAgentsDir)) {
      const sessionsDir = resolve(ocAgentsDir, entry, "sessions");
      if (!existsSync(sessionsDir)) continue;

      for (const file of readdirSync(sessionsDir)) {
        if (!file.endsWith(".jsonl")) continue;
        const fullPath = resolve(sessionsDir, file);
        if (sessionMatchesWorkspace(fullPath, workspaceDir)) {
          matches.push({ path: fullPath, mtime: statSync(fullPath).mtimeMs });
        }
      }
    }
  } catch (err) {
    console.warn("Warning: error scanning OpenClaw sessions:", err);
    return undefined;
  }

  if (matches.length === 0) return undefined;

  matches.sort((a, b) => b.mtime - a.mtime);
  console.log(`Found session: ${matches[0].path}`);
  return matches[0].path;
}

/** Check if a session JSONL file's header cwd matches the given workspace directory. */
export function sessionMatchesWorkspace(sessionPath: string, workspaceDir: string): boolean {
  try {
    const fd = readFileSync(sessionPath, "utf-8");
    const firstLine = fd.slice(0, fd.indexOf("\n"));
    const header = JSON.parse(firstLine);
    return header.type === "session" && resolve(header.cwd) === resolve(workspaceDir);
  } catch {
    return false;
  }
}

/**
 * A pi session file with its header's `cwd` set to `cwd`, or null when the
 * first line is not a session header. Only that line is touched; the rest is
 * spliced back byte for byte, never decoded.
 *
 * pi's `continueRecent` resumes only a session whose header `cwd` matches the
 * mind's own, so a session file moved to a different home without this is
 * passed over and the mind starts empty, with nothing telling it why.
 */
export function withPiSessionCwd(data: Buffer, cwd: string): Buffer | null {
  const end = data.indexOf(0x0a);
  const first = end === -1 ? data : data.subarray(0, end);
  let header: any;
  try {
    header = JSON.parse(first.toString("utf-8"));
  } catch {
    return null;
  }
  if (header?.type !== "session") return null;
  header.cwd = cwd;
  const rest = end === -1 ? Buffer.alloc(0) : data.subarray(end);
  return Buffer.concat([Buffer.from(JSON.stringify(header)), rest]);
}

/**
 * When pi created a session file, from the `<iso>_<id>.jsonl` name it gives
 * one (`:` and `.` written as `-`), or null for any other name.
 */
function piSessionFileTime(name: string): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3}Z)_/.exec(name);
  if (!m) return null;
  const date = new Date(`${m[1]}:${m[2]}:${m[3]}.${m[4]}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Point every pi session under `<root>/.mind/pi-sessions` at `cwd`.
 *
 * For an archive import, run on the extracted archive before it is copied
 * into the new mind dir: the archive is the only place the files are not yet
 * the mind's, and they are routinely larger than a mind-file rewrite will read.
 * Only real directories are descended and only regular files rewritten.
 *
 * pi resumes the newest file in a session dir by mtime, and every step of an
 * export and import leaves the mtimes at whenever that step ran. So each file
 * also gets back the time its name says it was created, which orders a dir's
 * sessions the way pi made them; the copy into the mind dir must keep it.
 */
export function rewritePiSessionCwds(root: string, cwd: string): void {
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = resolve(dir, entry);
      const stat = lstatSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile() && entry.endsWith(".jsonl")) {
        const data = withPiSessionCwd(readFileSync(path), cwd);
        if (data !== null) writeFileSync(path, data);
        const created = piSessionFileTime(entry);
        if (created) utimesSync(path, created, created);
      }
    }
  };
  const sessionsDir = resolve(root, ".mind/pi-sessions");
  if (existsSync(sessionsDir) && lstatSync(sessionsDir).isDirectory()) walk(sessionsDir);
}

/**
 * Import a session for the pi template.
 * OpenClaw sessions use the same JSONL format as pi-coding-agent,
 * so we copy directly and just update the cwd in the session header.
 */
export function importPiSession(sessionFile: string, mindDirPath: string) {
  // Canonical, as the mind's own cwd will be — pi compares the two by string.
  const homeDir = resolve(realpathSync(mindDirPath), "home");
  const piSessionDir = resolve(mindDirPath, ".mind/pi-sessions/main");
  mkdirSync(piSessionDir, { recursive: true });

  const content = readFileSync(sessionFile);
  const filename = basename(sessionFile);
  const destPath = resolve(piSessionDir, filename);
  writeFileSync(destPath, withPiSessionCwd(content, homeDir) ?? content);
  console.log(`Imported session (${content.toString("utf-8").trim().split("\n").length} entries)`);
}

type OpenClawDiscordConfig = {
  enabled?: boolean;
  token?: string;
  guilds?: Record<string, { channels?: Record<string, { allow?: boolean }> }>;
};

/** Import connector config from ~/.openclaw/openclaw.json as a system-level bridge. */
export function importOpenClawConnectors(name: string, _mindDirPath: string) {
  const configPath = resolve(homedir(), ".openclaw/openclaw.json");
  if (!existsSync(configPath)) return;

  let config: { channels?: Record<string, OpenClawDiscordConfig> };
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (err) {
    console.warn("Warning: failed to parse openclaw.json:", err);
    return;
  }

  const discord = config.channels?.discord;
  if (!discord?.enabled || !discord.token) return;

  // Write DISCORD_TOKEN to shared (system-level) env
  const envPath = sharedEnvPath();
  const env = readEnv(envPath);
  if (!env.DISCORD_TOKEN) {
    env.DISCORD_TOKEN = discord.token;
    writeEnv(envPath, env);
  }

  // Extract followed channel names from guilds config for mapping
  const channelMappings: Record<string, string> = {};
  if (discord.guilds) {
    for (const guild of Object.values(discord.guilds)) {
      if (!guild.channels) continue;
      for (const [channelName, ch] of Object.entries(guild.channels)) {
        if (ch.allow) {
          // Map external channel to same-named Volute channel
          channelMappings[channelName] = channelName;
        }
      }
    }
  }

  // Set up system-level Discord bridge with this mind as default
  setBridgeConfig("discord", {
    enabled: true,
    defaultMind: name,
    channelMappings,
  });

  console.log(`Imported Discord as system bridge (default mind: ${name})`);
  if (Object.keys(channelMappings).length > 0) {
    console.log(`Mapped channels: ${Object.keys(channelMappings).join(", ")}`);
  }
}

export function parseNameFromIdentity(identity: string): string | undefined {
  const match = identity.match(/\*\*Name:\*\*\s*(.+)/);
  if (match) {
    const raw = match[1].trim();
    // Skip template placeholder text
    if (!raw || raw.startsWith("*") || raw.startsWith("(")) return undefined;
    return raw
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9.-]/g, "");
  }
  return undefined;
}
