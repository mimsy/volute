import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { mindEnvPath, readEnv, writeEnv } from "../lib/env.js";
import { parseArgs } from "../lib/parse-args.js";
import { readVoluteConfig, writeVoluteConfig } from "../lib/volute-config.js";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    name: { type: "string" },
    session: { type: "string" },
    template: { type: "string" },
  });

  const inputPath = positional[0];

  // Detect .volute archive vs OpenClaw workspace
  if (inputPath && (inputPath.endsWith(".volute") || isZipFile(inputPath))) {
    await importArchive(resolve(inputPath), flags.name);
    return;
  }

  const wsDir = resolveWorkspace(inputPath);

  const { daemonFetch } = await import("../lib/daemon-client.js");
  const { getClient, urlOf } = await import("../lib/api-client.js");
  const client = getClient();

  const res = await daemonFetch(urlOf((client.api.minds as any).import.$url()), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspacePath: wsDir,
      name: flags.name,
      template: flags.template,
      sessionPath: flags.session,
    }),
  });

  const data = (await res.json()) as {
    ok?: boolean;
    error?: string;
    name?: string;
    port?: number;
    message?: string;
  };

  if (!res.ok) {
    console.error(data.error ?? "Failed to import mind");
    process.exit(1);
  }

  console.log(`\n${data.message ?? `Imported mind: ${data.name} (port ${data.port})`}`);
  console.log(`\n  volute mind start ${data.name}`);
}

/** Check if a file starts with the PK zip magic bytes. */
function isZipFile(path: string): boolean {
  const resolved = resolve(path);
  if (!existsSync(resolved)) return false;
  try {
    const fd = readFileSync(resolved, { encoding: null });
    return fd.length >= 4 && fd[0] === 0x50 && fd[1] === 0x4b && fd[2] === 0x03 && fd[3] === 0x04;
  } catch {
    return false;
  }
}

/** Import a .volute archive via the daemon. */
async function importArchive(archivePath: string, nameOverride?: string): Promise<void> {
  if (!existsSync(archivePath)) {
    console.error(`File not found: ${archivePath}`);
    process.exit(1);
  }

  const { extractArchive } = await import("../lib/archive.js");

  // Extract to temp dir
  const tempDir = resolve(tmpdir(), `volute-import-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });

  let extracted: Awaited<ReturnType<typeof extractArchive>>;
  try {
    extracted = extractArchive(archivePath, tempDir);
  } catch (err) {
    console.error(`Failed to extract archive: ${(err as Error).message}`);
    process.exit(1);
  }

  const { daemonFetch } = await import("../lib/daemon-client.js");
  const { getClient, urlOf } = await import("../lib/api-client.js");
  const client = getClient();

  const res = await daemonFetch(urlOf((client.api.minds as any).import.$url()), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      archivePath: tempDir,
      name: nameOverride,
      manifest: extracted.manifest,
    }),
  });

  const data = (await res.json()) as {
    ok?: boolean;
    error?: string;
    name?: string;
    port?: number;
    message?: string;
  };

  if (!res.ok) {
    console.error(data.error ?? "Failed to import mind");
    process.exit(1);
  }

  console.log(`\n${data.message ?? `Imported mind: ${data.name} (port ${data.port})`}`);
  console.log(`\n  volute mind start ${data.name}`);
}

/** Auto-detect OpenClaw workspace: explicit path > cwd > ~/.openclaw/workspace */
function resolveWorkspace(explicitPath?: string): string {
  if (explicitPath) {
    const wsDir = resolve(explicitPath);
    if (!existsSync(resolve(wsDir, "SOUL.md")) || !existsSync(resolve(wsDir, "IDENTITY.md"))) {
      console.error("Not a valid OpenClaw workspace: missing SOUL.md or IDENTITY.md");
      process.exit(1);
    }
    return wsDir;
  }

  // Try cwd
  const cwd = process.cwd();
  if (existsSync(resolve(cwd, "SOUL.md")) && existsSync(resolve(cwd, "IDENTITY.md"))) {
    console.log(`Using workspace: ${cwd}`);
    return cwd;
  }

  // Try ~/.openclaw/workspace
  const openclawWs = resolve(homedir(), ".openclaw/workspace");
  if (
    existsSync(resolve(openclawWs, "SOUL.md")) &&
    existsSync(resolve(openclawWs, "IDENTITY.md"))
  ) {
    console.log(`Using workspace: ${openclawWs}`);
    return openclawWs;
  }

  console.error(
    "Usage: volute mind import [<workspace-path>] [--name <name>] [--session <path>] [--template <name>]\n\n" +
      "No OpenClaw workspace found. Provide a path, run from a workspace, or ensure ~/.openclaw/workspace exists.",
  );
  process.exit(1);
}

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

/** Import connector config from ~/.openclaw/openclaw.json into the new mind. */
export function importOpenClawConnectors(name: string, mindDirPath: string) {
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

  // Write DISCORD_TOKEN to mind env
  const envPath = mindEnvPath(name);
  const env = readEnv(envPath);
  env.DISCORD_TOKEN = discord.token;
  writeEnv(envPath, env);

  // Extract followed channel names from guilds config
  const channelNames = new Set<string>();
  if (discord.guilds) {
    for (const guild of Object.values(discord.guilds)) {
      if (!guild.channels) continue;
      for (const [name, ch] of Object.entries(guild.channels)) {
        if (ch.allow) channelNames.add(name);
      }
    }
  }

  // Enable discord connector in volute.json
  const voluteConfig = readVoluteConfig(mindDirPath) ?? {};
  const connectors = new Set(voluteConfig.connectors ?? []);
  connectors.add("discord");
  voluteConfig.connectors = [...connectors];
  if (channelNames.size > 0) {
    voluteConfig.discord = { channels: [...channelNames] };
  }
  writeVoluteConfig(mindDirPath, voluteConfig);

  console.log("Imported Discord connector config");
  if (channelNames.size > 0) {
    console.log(`Imported followed channels: ${[...channelNames].join(", ")}`);
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
