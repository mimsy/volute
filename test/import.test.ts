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
import { basename, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

// We test the import helpers by importing them.
// Since they're not exported from the module, we'll test the logic inline.

const scratchDir = resolve("/tmp/import-test");

function writeJsonl(path: string, events: unknown[]) {
  writeFileSync(path, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
}

describe("import: parseNameFromIdentity", () => {
  // Inline the function for testing since it's not exported
  function parseNameFromIdentity(identity: string): string | undefined {
    const match = identity.match(/\*\*Name:\*\*\s*(.+)/);
    if (match) {
      const raw = match[1].trim();
      if (!raw || raw.startsWith("*") || raw.startsWith("(")) return undefined;
      return raw.toLowerCase().replace(/\s+/g, "-");
    }
    return undefined;
  }

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

  // Inline the function for testing
  function importPiSession(sessionFile: string, agentDirPath: string) {
    const homeDir = resolve(agentDirPath, "home");
    const piSessionDir = resolve(agentDirPath, ".volute/pi-sessions/main");
    mkdirSync(piSessionDir, { recursive: true });

    const content = readFileSync(sessionFile, "utf-8");
    const lines = content.trim().split("\n");

    if (lines.length > 0) {
      try {
        const header = JSON.parse(lines[0]);
        if (header.type === "session") {
          header.cwd = homeDir;
          lines[0] = JSON.stringify(header);
        }
      } catch {
        // Not a valid header, copy as-is
      }
    }

    const filename = basename(sessionFile);
    const destPath = resolve(piSessionDir, filename);
    writeFileSync(destPath, `${lines.join("\n")}\n`);
  }

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

  // Mirror of findOpenClawSession + sessionMatchesWorkspace from import.ts
  function sessionMatchesWorkspace(sessionPath: string, wsDir: string): boolean {
    try {
      const fd = readFileSync(sessionPath, "utf-8");
      const firstLine = fd.slice(0, fd.indexOf("\n"));
      const header = JSON.parse(firstLine);
      return header.type === "session" && resolve(header.cwd) === resolve(wsDir);
    } catch {
      return false;
    }
  }

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
