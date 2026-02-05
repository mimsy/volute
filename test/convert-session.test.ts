import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { convertSession } from "../src/lib/convert-session.js";

const scratchDir = resolve("/tmp/convert-session-test");

function writeJsonl(path: string, events: unknown[]) {
  writeFileSync(path, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
}

describe("convertSession", () => {
  beforeEach(() => {
    mkdirSync(scratchDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(scratchDir, { recursive: true, force: true });
    // Clean up SDK output
    const projectId = scratchDir.replace(/\//g, "-");
    const sdkDir = resolve(homedir(), ".claude", "projects", projectId);
    if (existsSync(sdkDir)) rmSync(sdkDir, { recursive: true, force: true });
  });

  it("converts user messages", () => {
    const sessionPath = resolve(scratchDir, "session.jsonl");
    writeJsonl(sessionPath, [
      {
        type: "message",
        id: "msg1",
        parentId: null,
        timestamp: "2026-01-31T01:00:00.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Hello" }],
        },
      },
    ]);

    const sessionId = convertSession({ sessionPath, projectDir: scratchDir });
    assert.ok(sessionId);

    const projectId = scratchDir.replace(/\//g, "-");
    const sdkPath = resolve(homedir(), ".claude", "projects", projectId, `${sessionId}.jsonl`);
    assert.ok(existsSync(sdkPath));

    const lines = readFileSync(sdkPath, "utf-8").trim().split("\n");
    assert.equal(lines.length, 1);

    const event = JSON.parse(lines[0]);
    assert.equal(event.type, "user");
    assert.equal(event.message.role, "user");
    assert.equal(event.sessionId, sessionId);
    assert.equal(event.isSidechain, false);
    assert.equal(event.userType, "external");
    assert.deepStrictEqual(event.message.content, [{ type: "text", text: "Hello" }]);
  });

  it("strips thinking blocks from assistant messages", () => {
    const sessionPath = resolve(scratchDir, "session.jsonl");
    writeJsonl(sessionPath, [
      {
        type: "message",
        id: "msg1",
        parentId: null,
        timestamp: "2026-01-31T01:00:00.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm", thinkingSignature: "sig123" },
            { type: "text", text: "Hello back!" },
          ],
        },
      },
    ]);

    const sessionId = convertSession({ sessionPath, projectDir: scratchDir });
    const projectId = scratchDir.replace(/\//g, "-");
    const sdkPath = resolve(homedir(), ".claude", "projects", projectId, `${sessionId}.jsonl`);
    const lines = readFileSync(sdkPath, "utf-8").trim().split("\n");
    const event = JSON.parse(lines[0]);

    assert.equal(event.type, "assistant");
    assert.equal(event.message.content.length, 1);
    assert.equal(event.message.content[0].type, "text");
    assert.equal(event.message.content[0].text, "Hello back!");

    // SDK-required message fields
    assert.equal(event.message.type, "message");
    assert.ok(event.message.id.startsWith("msg_imported_"));
    assert.equal(event.message.stop_sequence, null);
    assert.ok(event.requestId.startsWith("req_imported_"));
  });

  it("converts toolCall to tool_use", () => {
    const sessionPath = resolve(scratchDir, "session.jsonl");
    writeJsonl(sessionPath, [
      {
        type: "message",
        id: "msg1",
        parentId: null,
        timestamp: "2026-01-31T01:00:00.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "toolu_123",
              name: "read",
              arguments: { path: "/tmp/file.txt" },
            },
          ],
        },
      },
    ]);

    const sessionId = convertSession({ sessionPath, projectDir: scratchDir });
    const projectId = scratchDir.replace(/\//g, "-");
    const sdkPath = resolve(homedir(), ".claude", "projects", projectId, `${sessionId}.jsonl`);
    const lines = readFileSync(sdkPath, "utf-8").trim().split("\n");
    const event = JSON.parse(lines[0]);

    assert.equal(event.message.content[0].type, "tool_use");
    assert.equal(event.message.content[0].id, "toolu_123");
    assert.equal(event.message.content[0].name, "read");
    assert.deepStrictEqual(event.message.content[0].input, {
      path: "/tmp/file.txt",
    });
    assert.deepStrictEqual(event.message.content[0].caller, {
      type: "direct",
    });
  });

  it("converts toolResult to user message with tool_result", () => {
    const sessionPath = resolve(scratchDir, "session.jsonl");
    writeJsonl(sessionPath, [
      {
        type: "message",
        id: "msg1",
        parentId: null,
        timestamp: "2026-01-31T01:00:00.000Z",
        message: {
          role: "toolResult",
          toolCallId: "toolu_123",
          toolName: "read",
          content: [{ type: "text", text: "file contents" }],
          isError: false,
        },
      },
    ]);

    const sessionId = convertSession({ sessionPath, projectDir: scratchDir });
    const projectId = scratchDir.replace(/\//g, "-");
    const sdkPath = resolve(homedir(), ".claude", "projects", projectId, `${sessionId}.jsonl`);
    const lines = readFileSync(sdkPath, "utf-8").trim().split("\n");
    const event = JSON.parse(lines[0]);

    assert.equal(event.type, "user");
    assert.equal(event.message.role, "user");
    assert.equal(event.message.content[0].type, "tool_result");
    assert.equal(event.message.content[0].tool_use_id, "toolu_123");
    assert.deepStrictEqual(event.message.content[0].content, [
      { type: "text", text: "file contents" },
    ]);
  });

  it("skips non-message events", () => {
    const sessionPath = resolve(scratchDir, "session.jsonl");
    writeJsonl(sessionPath, [
      {
        type: "session",
        version: 3,
        id: "abc",
        timestamp: "2026-01-31T01:00:00.000Z",
      },
      {
        type: "model_change",
        id: "def",
        parentId: null,
        timestamp: "2026-01-31T01:00:00.000Z",
      },
      {
        type: "message",
        id: "msg1",
        parentId: null,
        timestamp: "2026-01-31T01:00:00.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Hello" }],
        },
      },
    ]);

    const sessionId = convertSession({ sessionPath, projectDir: scratchDir });
    const projectId = scratchDir.replace(/\//g, "-");
    const sdkPath = resolve(homedir(), ".claude", "projects", projectId, `${sessionId}.jsonl`);
    const lines = readFileSync(sdkPath, "utf-8").trim().split("\n");
    assert.equal(lines.length, 1);
  });

  it("maintains parent chain via id mapping", () => {
    const sessionPath = resolve(scratchDir, "session.jsonl");
    writeJsonl(sessionPath, [
      {
        type: "message",
        id: "msg1",
        parentId: null,
        timestamp: "2026-01-31T01:00:00.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Hello" }],
        },
      },
      {
        type: "message",
        id: "msg2",
        parentId: "msg1",
        timestamp: "2026-01-31T01:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hi!" }],
        },
      },
    ]);

    const sessionId = convertSession({ sessionPath, projectDir: scratchDir });
    const projectId = scratchDir.replace(/\//g, "-");
    const sdkPath = resolve(homedir(), ".claude", "projects", projectId, `${sessionId}.jsonl`);
    const lines = readFileSync(sdkPath, "utf-8").trim().split("\n");
    const event1 = JSON.parse(lines[0]);
    const event2 = JSON.parse(lines[1]);

    assert.equal(event1.parentUuid, null);
    assert.equal(event2.parentUuid, event1.uuid);
  });

  it("batches consecutive toolResults into a single user message", () => {
    const sessionPath = resolve(scratchDir, "session.jsonl");
    writeJsonl(sessionPath, [
      {
        type: "message",
        id: "msg1",
        parentId: null,
        timestamp: "2026-01-31T01:00:00.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "/a" } },
            { type: "toolCall", id: "toolu_2", name: "read", arguments: { path: "/b" } },
            { type: "toolCall", id: "toolu_3", name: "read", arguments: { path: "/c" } },
          ],
        },
      },
      {
        type: "message",
        id: "tr1",
        parentId: "msg1",
        timestamp: "2026-01-31T01:00:01.000Z",
        message: {
          role: "toolResult",
          toolCallId: "toolu_1",
          toolName: "read",
          content: [{ type: "text", text: "content a" }],
          isError: false,
        },
      },
      {
        type: "message",
        id: "tr2",
        parentId: "msg1",
        timestamp: "2026-01-31T01:00:01.001Z",
        message: {
          role: "toolResult",
          toolCallId: "toolu_2",
          toolName: "read",
          content: [{ type: "text", text: "content b" }],
          isError: false,
        },
      },
      {
        type: "message",
        id: "tr3",
        parentId: "msg1",
        timestamp: "2026-01-31T01:00:01.002Z",
        message: {
          role: "toolResult",
          toolCallId: "toolu_3",
          toolName: "read",
          content: [{ type: "text", text: "content c" }],
          isError: false,
        },
      },
    ]);

    const sessionId = convertSession({ sessionPath, projectDir: scratchDir });
    const projectId = scratchDir.replace(/\//g, "-");
    const sdkPath = resolve(homedir(), ".claude", "projects", projectId, `${sessionId}.jsonl`);
    const lines = readFileSync(sdkPath, "utf-8").trim().split("\n");
    // Should be 2 events: 1 assistant + 1 batched user (not 4)
    assert.equal(lines.length, 2);

    const toolResultEvent = JSON.parse(lines[1]);
    assert.equal(toolResultEvent.type, "user");
    assert.equal(toolResultEvent.message.content.length, 3);
    assert.equal(toolResultEvent.message.content[0].tool_use_id, "toolu_1");
    assert.equal(toolResultEvent.message.content[1].tool_use_id, "toolu_2");
    assert.equal(toolResultEvent.message.content[2].tool_use_id, "toolu_3");
  });

  it("maps OpenClaw model, stopReason, and usage to SDK format", () => {
    const sessionPath = resolve(scratchDir, "session.jsonl");
    writeJsonl(sessionPath, [
      {
        type: "message",
        id: "msg1",
        parentId: null,
        timestamp: "2026-01-31T01:00:00.000Z",
        message: {
          role: "assistant",
          model: "claude-opus-4-5",
          stopReason: "toolUse",
          usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 },
          content: [{ type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "/a" } }],
        },
      },
    ]);

    const sessionId = convertSession({ sessionPath, projectDir: scratchDir });
    const projectId = scratchDir.replace(/\//g, "-");
    const sdkPath = resolve(homedir(), ".claude", "projects", projectId, `${sessionId}.jsonl`);
    const lines = readFileSync(sdkPath, "utf-8").trim().split("\n");
    const event = JSON.parse(lines[0]);

    assert.equal(event.message.model, "claude-opus-4-5-20251101");
    assert.equal(event.message.stop_reason, "tool_use");
    assert.equal(event.message.stop_sequence, null);
    assert.deepStrictEqual(event.message.usage, {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
    });
  });

  it("adds sourceToolAssistantUUID to tool result messages", () => {
    const sessionPath = resolve(scratchDir, "session.jsonl");
    writeJsonl(sessionPath, [
      {
        type: "message",
        id: "msg1",
        parentId: null,
        timestamp: "2026-01-31T01:00:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "/a" } }],
        },
      },
      {
        type: "message",
        id: "tr1",
        parentId: "msg1",
        timestamp: "2026-01-31T01:00:01.000Z",
        message: {
          role: "toolResult",
          toolCallId: "toolu_1",
          toolName: "read",
          content: [{ type: "text", text: "content" }],
          isError: false,
        },
      },
    ]);

    const sessionId = convertSession({ sessionPath, projectDir: scratchDir });
    const projectId = scratchDir.replace(/\//g, "-");
    const sdkPath = resolve(homedir(), ".claude", "projects", projectId, `${sessionId}.jsonl`);
    const lines = readFileSync(sdkPath, "utf-8").trim().split("\n");
    const assistantEvent = JSON.parse(lines[0]);
    const toolResultEvent = JSON.parse(lines[1]);

    assert.equal(toolResultEvent.sourceToolAssistantUUID, assistantEvent.uuid);
    assert.equal(toolResultEvent.toolUseResult, "imported");
  });

  it("skips assistant messages that are only thinking", () => {
    const sessionPath = resolve(scratchDir, "session.jsonl");
    writeJsonl(sessionPath, [
      {
        type: "message",
        id: "msg1",
        parentId: null,
        timestamp: "2026-01-31T01:00:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "hmm", thinkingSignature: "sig" }],
        },
      },
    ]);

    const sessionId = convertSession({ sessionPath, projectDir: scratchDir });
    const projectId = scratchDir.replace(/\//g, "-");
    const sdkPath = resolve(homedir(), ".claude", "projects", projectId, `${sessionId}.jsonl`);
    const lines = readFileSync(sdkPath, "utf-8").trim().split("\n");
    // Should be empty (only a blank line from the trailing newline)
    assert.equal(lines.filter((l: string) => l.trim()).length, 0);
  });
});
