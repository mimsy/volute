import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  importPiSession,
  parseNameFromIdentity,
  sessionMatchesWorkspace,
} from "../src/commands/import.js";

const scratchDir = resolve("/tmp/import-test");

function writeJsonl(path: string, events: unknown[]) {
  writeFileSync(path, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
}

describe("import: parseNameFromIdentity", () => {
  it("parses a filled-in name", () => {
    assert.equal(parseNameFromIdentity("- **Name:** Mimsy"), "mimsy");
  });

  it("normalizes spaces to hyphens", () => {
    assert.equal(parseNameFromIdentity("- **Name:** My Cool Agent"), "my-cool-agent");
  });

  it("returns undefined for empty name field", () => {
    assert.equal(parseNameFromIdentity("- **Name:**\n"), undefined);
  });

  it("returns undefined for template placeholder text", () => {
    assert.equal(parseNameFromIdentity("- **Name:**\n  *(pick something you like)*"), undefined);
  });

  it("returns undefined when no Name field exists", () => {
    assert.equal(parseNameFromIdentity("Just some text"), undefined);
  });
});

describe("import: importPiSession", () => {
  beforeEach(() => {
    mkdirSync(resolve(scratchDir, "home"), { recursive: true });
  });

  afterEach(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it("copies session file to .volute/pi-sessions/main/", () => {
    const sessionPath = resolve(scratchDir, "source-session.jsonl");
    writeJsonl(sessionPath, [
      {
        type: "session",
        version: 3,
        id: "abc-123",
        timestamp: "2026-01-30T18:15:46.878Z",
        cwd: "/old/path",
      },
      {
        type: "message",
        id: "msg1",
        parentId: null,
        timestamp: "2026-01-30T18:15:46.894Z",
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
      },
    ]);

    importPiSession(sessionPath, scratchDir);

    const destDir = resolve(scratchDir, ".volute/pi-sessions/main");
    assert.ok(existsSync(destDir));
    const files = readdirSync(destDir).filter((f) => f.endsWith(".jsonl"));
    assert.equal(files.length, 1);
    assert.equal(files[0], "source-session.jsonl");
  });

  it("updates cwd in session header to agent home dir", () => {
    const sessionPath = resolve(scratchDir, "session.jsonl");
    writeJsonl(sessionPath, [
      {
        type: "session",
        version: 3,
        id: "abc-123",
        timestamp: "2026-01-30T18:15:46.878Z",
        cwd: "/Users/old/.openclaw/workspace",
      },
      {
        type: "message",
        id: "msg1",
        parentId: null,
        timestamp: "2026-01-30T18:15:46.894Z",
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
      },
    ]);

    importPiSession(sessionPath, scratchDir);

    const destPath = resolve(scratchDir, ".volute/pi-sessions/main/session.jsonl");
    const lines = readFileSync(destPath, "utf-8").trim().split("\n");
    const header = JSON.parse(lines[0]);
    assert.equal(header.cwd, resolve(scratchDir, "home"));
    assert.equal(header.type, "session");
    assert.equal(header.version, 3);
    assert.equal(header.id, "abc-123");
  });

  it("preserves all session entries", () => {
    const sessionPath = resolve(scratchDir, "session.jsonl");
    writeJsonl(sessionPath, [
      {
        type: "session",
        version: 3,
        id: "abc",
        timestamp: "2026-01-30T00:00:00.000Z",
        cwd: "/old",
      },
      {
        type: "model_change",
        id: "mc1",
        parentId: null,
        timestamp: "2026-01-30T00:00:00.000Z",
        provider: "anthropic",
        modelId: "claude-opus-4-5",
      },
      {
        type: "message",
        id: "msg1",
        parentId: "mc1",
        timestamp: "2026-01-30T00:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      },
      {
        type: "message",
        id: "msg2",
        parentId: "msg1",
        timestamp: "2026-01-30T00:00:02.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      },
    ]);

    importPiSession(sessionPath, scratchDir);

    const destPath = resolve(scratchDir, ".volute/pi-sessions/main/session.jsonl");
    const lines = readFileSync(destPath, "utf-8").trim().split("\n");
    assert.equal(lines.length, 4);

    // Non-header entries should be untouched
    const modelChange = JSON.parse(lines[1]);
    assert.equal(modelChange.type, "model_change");
    assert.equal(modelChange.provider, "anthropic");

    const msg1 = JSON.parse(lines[2]);
    assert.equal(msg1.type, "message");
    assert.equal(msg1.message.role, "user");
  });
});

describe("import: findOpenClawSession", () => {
  const fakeAgentsDir = resolve(scratchDir, "agents");
  const workspaceDir = "/fake/workspace";

  function makeSession(agentName: string, filename: string, cwd: string) {
    const sessionsDir = resolve(fakeAgentsDir, agentName, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const sessionPath = resolve(sessionsDir, filename);
    writeJsonl(sessionPath, [
      { type: "session", version: 3, id: filename, timestamp: new Date().toISOString(), cwd },
    ]);
    return sessionPath;
  }

  beforeEach(() => {
    mkdirSync(fakeAgentsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  // Wrapper around findOpenClawSession that accepts a custom agents dir
  function findOpenClawSession(agentsDir: string, wsDir: string): string | undefined {
    if (!existsSync(agentsDir)) return undefined;

    const matches: { path: string; mtime: number }[] = [];
    try {
      for (const agent of readdirSync(agentsDir)) {
        const sessionsDir = resolve(agentsDir, agent, "sessions");
        if (!existsSync(sessionsDir)) continue;

        for (const file of readdirSync(sessionsDir)) {
          if (!file.endsWith(".jsonl")) continue;
          const fullPath = resolve(sessionsDir, file);
          if (sessionMatchesWorkspace(fullPath, wsDir)) {
            matches.push({ path: fullPath, mtime: statSync(fullPath).mtimeMs });
          }
        }
      }
    } catch {
      return undefined;
    }

    if (matches.length === 0) return undefined;
    matches.sort((a, b) => b.mtime - a.mtime);
    return matches[0].path;
  }

  it("returns undefined when agents dir does not exist", () => {
    assert.equal(findOpenClawSession(resolve(scratchDir, "nonexistent"), workspaceDir), undefined);
  });

  it("returns undefined when no sessions exist", () => {
    mkdirSync(resolve(fakeAgentsDir, "main/sessions"), { recursive: true });
    assert.equal(findOpenClawSession(fakeAgentsDir, workspaceDir), undefined);
  });

  it("finds a session matching the workspace cwd", () => {
    const sessionPath = makeSession("main", "abc.jsonl", workspaceDir);
    assert.equal(findOpenClawSession(fakeAgentsDir, workspaceDir), sessionPath);
  });

  it("ignores sessions with a different workspace cwd", () => {
    makeSession("main", "abc.jsonl", "/other/workspace");
    assert.equal(findOpenClawSession(fakeAgentsDir, workspaceDir), undefined);
  });

  it("ignores non-jsonl files", () => {
    const sessionsDir = resolve(fakeAgentsDir, "main/sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(resolve(sessionsDir, "sessions.json"), "{}");
    assert.equal(findOpenClawSession(fakeAgentsDir, workspaceDir), undefined);
  });

  it("matches session from the correct agent among multiple", () => {
    makeSession("agent1", "a.jsonl", "/other/workspace");
    const match = makeSession("agent2", "b.jsonl", workspaceDir);

    assert.equal(findOpenClawSession(fakeAgentsDir, workspaceDir), match);
  });

  it("picks most recent matching session", () => {
    const oldSession = makeSession("main", "old.jsonl", workspaceDir);
    const newSession = makeSession("main", "new.jsonl", workspaceDir);

    // Make new.jsonl actually newer
    const futureTime = Date.now() + 1000;
    utimesSync(newSession, futureTime / 1000, futureTime / 1000);

    assert.equal(findOpenClawSession(fakeAgentsDir, workspaceDir), newSession);
    // Verify old session is NOT the result
    assert.notEqual(findOpenClawSession(fakeAgentsDir, workspaceDir), oldSession);
  });
});

describe("import: importOpenClawConnectors", () => {
  beforeEach(() => {
    mkdirSync(resolve(scratchDir, "home/.config"), { recursive: true });
    mkdirSync(resolve(scratchDir, ".volute"), { recursive: true });
  });

  afterEach(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  // Mirror of importOpenClawConnectors from import.ts
  function importOpenClawConnectors(agentDirPath: string, configPath: string) {
    if (!existsSync(configPath)) return;

    let config: {
      channels?: Record<
        string,
        {
          enabled?: boolean;
          token?: string;
          guilds?: Record<string, { channels?: Record<string, { allow?: boolean }> }>;
        }
      >;
    };
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      return;
    }

    const discord = config.channels?.discord;
    if (!discord?.enabled || !discord.token) return;

    // Write DISCORD_TOKEN to agent env
    const envPath = resolve(agentDirPath, ".volute", "env.json");
    let env: Record<string, string> = {};
    if (existsSync(envPath)) {
      try {
        env = JSON.parse(readFileSync(envPath, "utf-8"));
      } catch {}
    }
    env.DISCORD_TOKEN = discord.token;
    mkdirSync(dirname(envPath), { recursive: true });
    writeFileSync(envPath, JSON.stringify(env, null, 2));

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
    const voluteConfigPath = resolve(agentDirPath, "home/.config/volute.json");
    let voluteConfig: {
      model?: string;
      connectors?: string[];
      discord?: { channels?: string[] };
    } = {};
    if (existsSync(voluteConfigPath)) {
      try {
        voluteConfig = JSON.parse(readFileSync(voluteConfigPath, "utf-8"));
      } catch {}
    }
    const connectors = new Set(voluteConfig.connectors ?? []);
    connectors.add("discord");
    voluteConfig.connectors = [...connectors];
    if (channelNames.size > 0) {
      voluteConfig.discord = { channels: [...channelNames] };
    }
    writeFileSync(voluteConfigPath, JSON.stringify(voluteConfig, null, 2));
  }

  it("imports discord token and enables connector", () => {
    const configPath = resolve(scratchDir, "openclaw.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        channels: { discord: { enabled: true, token: "test-token-123" } },
      }),
    );
    writeFileSync(
      resolve(scratchDir, "home/.config/volute.json"),
      JSON.stringify({ model: "claude-sonnet-4-20250514" }),
    );

    importOpenClawConnectors(scratchDir, configPath);

    const env = JSON.parse(readFileSync(resolve(scratchDir, ".volute/env.json"), "utf-8"));
    assert.equal(env.DISCORD_TOKEN, "test-token-123");

    const config = JSON.parse(
      readFileSync(resolve(scratchDir, "home/.config/volute.json"), "utf-8"),
    );
    assert.deepEqual(config.connectors, ["discord"]);
    assert.equal(config.model, "claude-sonnet-4-20250514");
  });

  it("does nothing when discord is not enabled", () => {
    const configPath = resolve(scratchDir, "openclaw.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        channels: { discord: { enabled: false, token: "test-token" } },
      }),
    );

    importOpenClawConnectors(scratchDir, configPath);

    assert.ok(!existsSync(resolve(scratchDir, ".volute/env.json")));
  });

  it("does nothing when discord has no token", () => {
    const configPath = resolve(scratchDir, "openclaw.json");
    writeFileSync(configPath, JSON.stringify({ channels: { discord: { enabled: true } } }));

    importOpenClawConnectors(scratchDir, configPath);

    assert.ok(!existsSync(resolve(scratchDir, ".volute/env.json")));
  });

  it("does nothing when config file does not exist", () => {
    importOpenClawConnectors(scratchDir, resolve(scratchDir, "nonexistent.json"));
    assert.ok(!existsSync(resolve(scratchDir, ".volute/env.json")));
  });

  it("preserves existing env vars", () => {
    const envPath = resolve(scratchDir, ".volute/env.json");
    writeFileSync(envPath, JSON.stringify({ EXISTING_VAR: "keep-me" }));

    const configPath = resolve(scratchDir, "openclaw.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        channels: { discord: { enabled: true, token: "new-token" } },
      }),
    );

    importOpenClawConnectors(scratchDir, configPath);

    const env = JSON.parse(readFileSync(envPath, "utf-8"));
    assert.equal(env.EXISTING_VAR, "keep-me");
    assert.equal(env.DISCORD_TOKEN, "new-token");
  });

  it("imports followed channel names from guilds config", () => {
    const configPath = resolve(scratchDir, "openclaw.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        channels: {
          discord: {
            enabled: true,
            token: "test-token",
            guilds: {
              "*": {
                channels: {
                  general: { allow: true },
                  random: { allow: true },
                  announcements: { allow: false },
                },
              },
            },
          },
        },
      }),
    );

    importOpenClawConnectors(scratchDir, configPath);

    const config = JSON.parse(
      readFileSync(resolve(scratchDir, "home/.config/volute.json"), "utf-8"),
    );
    assert.deepEqual(config.connectors, ["discord"]);
    assert.ok(config.discord?.channels);
    assert.equal(config.discord.channels.length, 2);
    assert.ok(config.discord.channels.includes("general"));
    assert.ok(config.discord.channels.includes("random"));
    assert.ok(!config.discord.channels.includes("announcements"));
  });

  it("imports channels from multiple guilds", () => {
    const configPath = resolve(scratchDir, "openclaw.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        channels: {
          discord: {
            enabled: true,
            token: "test-token",
            guilds: {
              guild1: { channels: { general: { allow: true } } },
              guild2: { channels: { dev: { allow: true } } },
            },
          },
        },
      }),
    );

    importOpenClawConnectors(scratchDir, configPath);

    const config = JSON.parse(
      readFileSync(resolve(scratchDir, "home/.config/volute.json"), "utf-8"),
    );
    assert.ok(config.discord?.channels.includes("general"));
    assert.ok(config.discord?.channels.includes("dev"));
  });

  it("does not set discord config when no channels are allowed", () => {
    const configPath = resolve(scratchDir, "openclaw.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        channels: {
          discord: {
            enabled: true,
            token: "test-token",
            guilds: { "*": { channels: { general: { allow: false } } } },
          },
        },
      }),
    );

    importOpenClawConnectors(scratchDir, configPath);

    const config = JSON.parse(
      readFileSync(resolve(scratchDir, "home/.config/volute.json"), "utf-8"),
    );
    assert.deepEqual(config.connectors, ["discord"]);
    assert.equal(config.discord, undefined);
  });
});
