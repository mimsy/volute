import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
 * Import a session for the pi template.
 * OpenClaw sessions use the same JSONL format as pi-coding-agent,
 * so we copy directly and just update the cwd in the session header.
 */
export function importPiSession(sessionFile: string, mindDirPath: string) {
  const homeDir = resolve(mindDirPath, "home");
  const piSessionDir = resolve(mindDirPath, ".mind/pi-sessions/main");
  mkdirSync(piSessionDir, { recursive: true });

  // Read session and update cwd in header to point to new mind's home dir
  const content = readFileSync(sessionFile, "utf-8");
  const lines = content.trim().split("\n");

  try {
    const header = JSON.parse(lines[0]);
    if (header.type === "session") {
      header.cwd = homeDir;
      lines[0] = JSON.stringify(header);
    }
  } catch {
    // Not a valid header, copy as-is
  }

  const filename = basename(sessionFile);
  const destPath = resolve(piSessionDir, filename);
  writeFileSync(destPath, `${lines.join("\n")}\n`);
  console.log(`Imported session (${lines.length} entries)`);
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
