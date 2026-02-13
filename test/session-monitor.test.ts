import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  encodeCwd,
  getSessionUpdates,
  parseJsonlEntries,
  readSessionLog,
  resolveAgentSdkJsonl,
  resolvePiJsonl,
  summarizeEntries,
} from "../templates/_base/src/lib/session-monitor.js";

// --- Test fixtures ---

function agentSdkUserEntry(text: string, timestamp?: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    timestamp: timestamp ?? new Date().toISOString(),
  });
}

function agentSdkAssistantEntry(
  text: string,
  tools?: { name: string; input?: any }[],
  timestamp?: string,
): string {
  const content: any[] = [];
  if (text) content.push({ type: "text", text });
  if (tools) {
    for (const t of tools) {
      content.push({ type: "tool_use", name: t.name, input: t.input ?? {} });
    }
  }
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content },
    timestamp: timestamp ?? new Date().toISOString(),
  });
}

function piUserEntry(text: string, timestamp?: string): string {
  return JSON.stringify({
    type: "message",
    message: { role: "user", content: [{ type: "text", text }] },
    timestamp: timestamp ?? new Date().toISOString(),
  });
}

function piAssistantEntry(
  text: string,
  tools?: { name: string; arguments?: any }[],
  timestamp?: string,
): string {
  const content: any[] = [];
  if (text) content.push({ type: "text", text });
  if (tools) {
    for (const t of tools) {
      content.push({ type: "toolCall", name: t.name, arguments: t.arguments ?? {} });
    }
  }
  return JSON.stringify({
    type: "message",
    message: { role: "assistant", content },
    timestamp: timestamp ?? new Date().toISOString(),
  });
}

// --- Tests ---

describe("parseJsonlEntries", () => {
  it("parses agent-sdk user messages", () => {
    const lines = [agentSdkUserEntry("hello world")];
    const entries = parseJsonlEntries(lines, "agent-sdk");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].role, "user");
    assert.equal(entries[0].text, "hello world");
  });

  it("parses agent-sdk assistant messages with tool uses", () => {
    const lines = [
      agentSdkAssistantEntry("I'll edit that file", [
        { name: "Edit", input: { file_path: "/foo/bar.ts" } },
      ]),
    ];
    const entries = parseJsonlEntries(lines, "agent-sdk");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].role, "assistant");
    assert.equal(entries[0].text, "I'll edit that file");
    assert.equal(entries[0].toolUses!.length, 1);
    assert.equal(entries[0].toolUses![0].name, "Edit");
    assert.equal(entries[0].toolUses![0].primaryArg, "/foo/bar.ts");
  });

  it("parses pi user messages", () => {
    const lines = [piUserEntry("how do I deploy?")];
    const entries = parseJsonlEntries(lines, "pi");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].role, "user");
    assert.equal(entries[0].text, "how do I deploy?");
  });

  it("parses pi assistant messages with tool calls", () => {
    const lines = [
      piAssistantEntry("Running command", [{ name: "exec", arguments: { command: "npm test" } }]),
    ];
    const entries = parseJsonlEntries(lines, "pi");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].role, "assistant");
    assert.equal(entries[0].toolUses!.length, 1);
    assert.equal(entries[0].toolUses![0].name, "exec");
    assert.equal(entries[0].toolUses![0].primaryArg, "npm test");
  });

  it("skips invalid JSON lines", () => {
    const lines = ["not json", agentSdkUserEntry("valid")];
    const entries = parseJsonlEntries(lines, "agent-sdk");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].text, "valid");
  });

  it("skips unrecognized entry types", () => {
    const lines = [JSON.stringify({ type: "result", usage: {} })];
    const entries = parseJsonlEntries(lines, "agent-sdk");
    assert.equal(entries.length, 0);
  });
});

describe("summarizeEntries", () => {
  it("returns null for empty entries", () => {
    assert.equal(summarizeEntries([]), null);
  });

  it("extracts first user text and tool counts", () => {
    const entries = parseJsonlEntries(
      [
        agentSdkUserEntry("fix the bug"),
        agentSdkAssistantEntry("On it", [
          { name: "Edit", input: { file_path: "a.ts" } },
          { name: "Edit", input: { file_path: "b.ts" } },
          { name: "Bash", input: { command: "npm test" } },
        ]),
      ],
      "agent-sdk",
    );
    const summary = summarizeEntries(entries)!;
    assert.equal(summary.firstUserText, "fix the bug");
    assert.equal(summary.toolCounts.edits, 2);
    assert.equal(summary.toolCounts.commands, 1);
    assert.equal(summary.toolCounts.reads, 0);
    assert.equal(summary.messageCount, 2);
  });

  it("captures last assistant text", () => {
    const entries = parseJsonlEntries(
      [
        agentSdkUserEntry("hello"),
        agentSdkAssistantEntry("first response"),
        agentSdkAssistantEntry("second response"),
      ],
      "agent-sdk",
    );
    const summary = summarizeEntries(entries)!;
    assert.equal(summary.lastAssistantText, "second response");
  });

  it("categorizes read tools correctly", () => {
    const entries = parseJsonlEntries(
      [
        agentSdkAssistantEntry("reading", [
          { name: "Read", input: { path: "file.ts" } },
          { name: "Grep", input: { pattern: "foo" } },
          { name: "Glob", input: { pattern: "*.ts" } },
        ]),
      ],
      "agent-sdk",
    );
    const summary = summarizeEntries(entries)!;
    assert.equal(summary.toolCounts.reads, 3);
  });
});

describe("encodeCwd", () => {
  it("replaces slashes with dashes", () => {
    assert.equal(encodeCwd("/Users/foo/home"), "-Users-foo-home");
  });

  it("replaces dots with dashes", () => {
    assert.equal(encodeCwd("/Users/foo/.volute"), "-Users-foo--volute");
  });
});

describe("getSessionUpdates", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = resolve(tmpdir(), `session-monitor-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when no other sessions exist", () => {
    const sessionsDir = resolve(tmpDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(resolve(sessionsDir, "main.json"), JSON.stringify({ sessionId: "abc" }));

    const result = getSessionUpdates({
      currentSession: "main",
      sessionsDir,
      cursorFile: resolve(tmpDir, "session-cursors.json"),
      jsonlResolver: () => null,
      format: "agent-sdk",
    });
    assert.equal(result, null);
  });

  it("returns summary when other sessions have activity", () => {
    const sessionsDir = resolve(tmpDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(resolve(sessionsDir, "main.json"), JSON.stringify({ sessionId: "abc" }));
    writeFileSync(resolve(sessionsDir, "discord.json"), JSON.stringify({ sessionId: "def" }));

    const jsonlPath = resolve(tmpDir, "discord.jsonl");
    const ts = new Date(Date.now() - 180000).toISOString(); // 3 minutes ago
    writeFileSync(
      jsonlPath,
      [
        agentSdkUserEntry("how do I deploy this?", ts),
        agentSdkAssistantEntry(
          "I'll help",
          [
            { name: "Edit", input: { file_path: "deploy.ts" } },
            { name: "Edit", input: { file_path: "config.ts" } },
            { name: "Bash", input: { command: "npm run deploy" } },
          ],
          ts,
        ),
      ].join("\n") + "\n",
    );

    const result = getSessionUpdates({
      currentSession: "main",
      sessionsDir,
      cursorFile: resolve(tmpDir, "session-cursors.json"),
      jsonlResolver: (name) => (name === "discord" ? jsonlPath : null),
      format: "agent-sdk",
    });

    assert.ok(result !== null);
    assert.ok(result!.includes("[Session Activity]"));
    assert.ok(result!.includes("discord"));
    assert.ok(result!.includes("how do I deploy this?"));
    assert.ok(result!.includes("edited 2 files"));
    assert.ok(result!.includes("ran 1 commands"));
  });

  it("tracks cursor state and skips already-seen activity", () => {
    const sessionsDir = resolve(tmpDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(resolve(sessionsDir, "main.json"), JSON.stringify({ sessionId: "abc" }));
    writeFileSync(resolve(sessionsDir, "discord.json"), JSON.stringify({ sessionId: "def" }));

    const jsonlPath = resolve(tmpDir, "discord.jsonl");
    writeFileSync(jsonlPath, agentSdkUserEntry("first message") + "\n");

    const cursorFile = resolve(tmpDir, "session-cursors.json");

    // First call should see activity
    const result1 = getSessionUpdates({
      currentSession: "main",
      sessionsDir,
      cursorFile,
      jsonlResolver: (name) => (name === "discord" ? jsonlPath : null),
      format: "agent-sdk",
    });
    assert.ok(result1 !== null);
    assert.ok(existsSync(cursorFile));

    // Second call with no new activity should return null
    const result2 = getSessionUpdates({
      currentSession: "main",
      sessionsDir,
      cursorFile,
      jsonlResolver: (name) => (name === "discord" ? jsonlPath : null),
      format: "agent-sdk",
    });
    assert.equal(result2, null);
  });

  it("picks up new activity after cursor", () => {
    const sessionsDir = resolve(tmpDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(resolve(sessionsDir, "main.json"), JSON.stringify({ sessionId: "abc" }));
    writeFileSync(resolve(sessionsDir, "discord.json"), JSON.stringify({ sessionId: "def" }));

    const jsonlPath = resolve(tmpDir, "discord.jsonl");
    const cursorFile = resolve(tmpDir, "session-cursors.json");

    writeFileSync(jsonlPath, agentSdkUserEntry("first") + "\n");

    // First call
    getSessionUpdates({
      currentSession: "main",
      sessionsDir,
      cursorFile,
      jsonlResolver: (name) => (name === "discord" ? jsonlPath : null),
      format: "agent-sdk",
    });

    // Append new content
    appendFileSync(jsonlPath, agentSdkUserEntry("second message") + "\n");

    // Second call should pick up the new message
    const result = getSessionUpdates({
      currentSession: "main",
      sessionsDir,
      cursorFile,
      jsonlResolver: (name) => (name === "discord" ? jsonlPath : null),
      format: "agent-sdk",
    });
    assert.ok(result !== null);
    assert.ok(result!.includes("second message"));
  });

  it("excludes new-* ephemeral sessions", () => {
    const sessionsDir = resolve(tmpDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(resolve(sessionsDir, "main.json"), JSON.stringify({ sessionId: "abc" }));
    writeFileSync(resolve(sessionsDir, "new-12345.json"), JSON.stringify({ sessionId: "xyz" }));

    const result = getSessionUpdates({
      currentSession: "main",
      sessionsDir,
      cursorFile: resolve(tmpDir, "session-cursors.json"),
      jsonlResolver: () => null,
      format: "agent-sdk",
    });
    assert.equal(result, null);
  });

  it("resets cursor when offset past EOF", () => {
    const sessionsDir = resolve(tmpDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(resolve(sessionsDir, "main.json"), JSON.stringify({ sessionId: "abc" }));
    writeFileSync(resolve(sessionsDir, "discord.json"), JSON.stringify({ sessionId: "def" }));

    const jsonlPath = resolve(tmpDir, "discord.jsonl");
    writeFileSync(jsonlPath, agentSdkUserEntry("hello") + "\n");

    // Pre-set cursor to a huge offset
    const cursorFile = resolve(tmpDir, "session-cursors.json");
    writeFileSync(cursorFile, JSON.stringify({ main: { discord: { offset: 999999 } } }));

    // Should reset offset and read the whole file
    const result = getSessionUpdates({
      currentSession: "main",
      sessionsDir,
      cursorFile,
      jsonlResolver: (name) => (name === "discord" ? jsonlPath : null),
      format: "agent-sdk",
    });
    assert.ok(result !== null);
    assert.ok(result!.includes("hello"));
  });

  it("handles missing JSONL files gracefully", () => {
    const sessionsDir = resolve(tmpDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(resolve(sessionsDir, "main.json"), JSON.stringify({ sessionId: "abc" }));
    writeFileSync(resolve(sessionsDir, "discord.json"), JSON.stringify({ sessionId: "def" }));

    const result = getSessionUpdates({
      currentSession: "main",
      sessionsDir,
      cursorFile: resolve(tmpDir, "session-cursors.json"),
      jsonlResolver: () => "/nonexistent/path.jsonl",
      format: "agent-sdk",
    });
    assert.equal(result, null);
  });

  it("returns summary for pi format sessions", () => {
    const sessionsDir = resolve(tmpDir, "pi-sessions");
    const discordDir = resolve(sessionsDir, "discord");
    mkdirSync(discordDir, { recursive: true });

    const jsonlPath = resolve(discordDir, "session.jsonl");
    const ts = new Date(Date.now() - 120000).toISOString(); // 2 minutes ago
    writeFileSync(
      jsonlPath,
      [
        piUserEntry("what's the status?", ts),
        piAssistantEntry(
          "Checking now",
          [{ name: "exec", arguments: { command: "git status" } }],
          ts,
        ),
      ].join("\n") + "\n",
    );

    const result = getSessionUpdates({
      currentSession: "main",
      sessionsDir,
      cursorFile: resolve(tmpDir, "session-cursors.json"),
      jsonlResolver: (name) => {
        if (name !== "discord") return null;
        return jsonlPath;
      },
      format: "pi",
    });

    assert.ok(result !== null);
    assert.ok(result!.includes("[Session Activity]"));
    assert.ok(result!.includes("discord"));
    assert.ok(result!.includes("what's the status?"));
    assert.ok(result!.includes("ran 1 commands"));
  });

  it("handles corrupted cursor file", () => {
    const sessionsDir = resolve(tmpDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(resolve(sessionsDir, "main.json"), JSON.stringify({ sessionId: "abc" }));
    writeFileSync(resolve(sessionsDir, "discord.json"), JSON.stringify({ sessionId: "def" }));

    const jsonlPath = resolve(tmpDir, "discord.jsonl");
    writeFileSync(jsonlPath, agentSdkUserEntry("hello") + "\n");

    const cursorFile = resolve(tmpDir, "session-cursors.json");
    writeFileSync(cursorFile, "not valid json!!!");

    // Should recover and still work
    const result = getSessionUpdates({
      currentSession: "main",
      sessionsDir,
      cursorFile,
      jsonlResolver: (name) => (name === "discord" ? jsonlPath : null),
      format: "agent-sdk",
    });
    assert.ok(result !== null);
    assert.ok(result!.includes("hello"));
  });
});

describe("readSessionLog", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = resolve(tmpdir(), `session-reader-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns formatted log for agent-sdk entries", () => {
    const jsonlPath = resolve(tmpDir, "session.jsonl");
    writeFileSync(
      jsonlPath,
      [
        agentSdkUserEntry("fix the tests", "2025-01-15T10:00:00Z"),
        agentSdkAssistantEntry(
          "I'll run them first",
          [{ name: "Bash", input: { command: "npm test" } }],
          "2025-01-15T10:00:30Z",
        ),
      ].join("\n") + "\n",
    );

    const output = readSessionLog({ jsonlPath, format: "agent-sdk" });
    assert.ok(output.includes("User: fix the tests"));
    assert.ok(output.includes("Assistant: I'll run them first"));
    assert.ok(output.includes("[Bash npm test]"));
  });

  it("returns formatted log for pi entries", () => {
    const jsonlPath = resolve(tmpDir, "session.jsonl");
    writeFileSync(
      jsonlPath,
      [
        piUserEntry("check the deployment", "2025-01-15T14:00:00Z"),
        piAssistantEntry(
          "Let me check",
          [{ name: "exec", arguments: { command: "kubectl get pods" } }],
          "2025-01-15T14:00:30Z",
        ),
      ].join("\n") + "\n",
    );

    const output = readSessionLog({ jsonlPath, format: "pi" });
    assert.ok(output.includes("User: check the deployment"));
    assert.ok(output.includes("Assistant: Let me check"));
    assert.ok(output.includes("[exec kubectl get pods]"));
  });

  it("returns 'No session log found.' for missing files", () => {
    const output = readSessionLog({
      jsonlPath: "/nonexistent/path.jsonl",
      format: "agent-sdk",
    });
    assert.equal(output, "No session log found.");
  });

  it("limits output to last N lines", () => {
    const jsonlPath = resolve(tmpDir, "session.jsonl");
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(agentSdkUserEntry(`message ${i}`));
    }
    writeFileSync(jsonlPath, lines.join("\n") + "\n");

    const output = readSessionLog({ jsonlPath, format: "agent-sdk", lines: 3 });
    assert.ok(!output.includes("message 0"));
    assert.ok(output.includes("message 9"));
  });
});

describe("resolveAgentSdkJsonl", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = resolve(tmpdir(), `sdk-resolve-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null for missing session file", () => {
    const result = resolveAgentSdkJsonl(tmpDir, "nonexistent", "/home/user");
    assert.equal(result, null);
  });

  it("returns null for session file without sessionId", () => {
    writeFileSync(resolve(tmpDir, "broken.json"), JSON.stringify({}));
    const result = resolveAgentSdkJsonl(tmpDir, "broken", "/home/user");
    assert.equal(result, null);
  });

  it("constructs correct JSONL path", () => {
    writeFileSync(resolve(tmpDir, "main.json"), JSON.stringify({ sessionId: "abc-123" }));
    const result = resolveAgentSdkJsonl(tmpDir, "main", "/Users/foo/home");
    assert.ok(result !== null);
    assert.ok(result!.includes(".claude/projects/-Users-foo-home/abc-123.jsonl"));
  });
});

describe("resolvePiJsonl", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = resolve(tmpdir(), `pi-resolve-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null for missing session directory", () => {
    const result = resolvePiJsonl(tmpDir, "nonexistent");
    assert.equal(result, null);
  });

  it("returns most recent JSONL file", () => {
    const sessionDir = resolve(tmpDir, "discord");
    mkdirSync(sessionDir, { recursive: true });
    const oldPath = resolve(sessionDir, "old.jsonl");
    const newPath = resolve(sessionDir, "new.jsonl");
    writeFileSync(oldPath, "old data");
    writeFileSync(newPath, "new data");
    // Ensure distinct mtimes (filesystem resolution can be coarse)
    utimesSync(oldPath, new Date("2025-01-01"), new Date("2025-01-01"));
    utimesSync(newPath, new Date("2025-01-02"), new Date("2025-01-02"));

    const result = resolvePiJsonl(tmpDir, "discord");
    assert.ok(result !== null);
    assert.ok(result!.endsWith("new.jsonl"));
  });

  it("returns null for session dir with no JSONL files", () => {
    const sessionDir = resolve(tmpDir, "empty");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(resolve(sessionDir, "not-jsonl.txt"), "nope");

    const result = resolvePiJsonl(tmpDir, "empty");
    assert.equal(result, null);
  });
});
