import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createRouter } from "../templates/_base/src/lib/router.js";
import type { HandlerMeta, Listener, VoluteContentPart } from "../templates/_base/src/lib/types.js";

type HandlerCall = {
  content: VoluteContentPart[];
  meta: HandlerMeta;
};

function createTestHandlers() {
  const agentCalls = new Map<string, HandlerCall[]>();
  const fileCalls = new Map<string, HandlerCall[]>();

  const agentHandler = (session: string) => ({
    handle(content: VoluteContentPart[], meta: HandlerMeta, listener: Listener) {
      const calls = agentCalls.get(session) ?? [];
      calls.push({ content, meta });
      agentCalls.set(session, calls);
      queueMicrotask(() => listener({ type: "done", messageId: meta.messageId }));
      return () => {};
    },
  });

  const fileHandler = (path: string) => ({
    handle(content: VoluteContentPart[], meta: HandlerMeta, listener: Listener) {
      const calls = fileCalls.get(path) ?? [];
      calls.push({ content, meta });
      fileCalls.set(path, calls);
      queueMicrotask(() => listener({ type: "done", messageId: meta.messageId }));
      return () => {};
    },
  });

  return { agentHandler, fileHandler, agentCalls, fileCalls };
}

function writeConfig(dir: string, config: object): string {
  const path = join(dir, "routes.json");
  writeFileSync(path, JSON.stringify(config));
  return path;
}

function waitMicrotask(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

describe("router invite gating", () => {
  it("unmatched channel + gateUnmatched sends invite and saves message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "router-invite-"));
    const configPath = writeConfig(dir, {
      gateUnmatched: true,
      rules: [{ channel: "web", session: "web" }],
      default: "main",
    });

    const { agentHandler, fileHandler, agentCalls, fileCalls } = createTestHandlers();
    const router = createRouter({ configPath, agentHandler, fileHandler });

    const events: string[] = [];
    router.route(
      [{ type: "text", text: "hello from discord" }],
      { channel: "discord:123", sender: "alice", platform: "discord" },
      (e) => events.push(e.type),
    );

    await waitMicrotask();

    // Invite notification sent to main session
    const mainCalls = agentCalls.get("main");
    assert.ok(mainCalls, "should send invite to main session");
    assert.equal(mainCalls.length, 1);
    const notifText = (mainCalls[0].content[0] as { text: string }).text;
    assert.ok(notifText.includes("[Channel Invite]"), "notification should contain invite header");
    assert.ok(notifText.includes("discord:123"), "notification should contain channel name");
    assert.ok(notifText.includes("alice"), "notification should contain sender");
    assert.ok(
      notifText.includes("hello from discord"),
      "notification should contain message preview",
    );

    // Sender gets done (not the invite response)
    assert.deepEqual(events, ["done"], "sender should only receive done event");

    // Message saved to file
    const fileKey = "inbox/discord-123.md";
    const fCalls = fileCalls.get(fileKey);
    assert.ok(fCalls, "should save message to file");
    assert.equal(fCalls.length, 1);
  });

  it("second message from same gated channel appends to file and emits done", async () => {
    const dir = mkdtempSync(join(tmpdir(), "router-invite-"));
    const configPath = writeConfig(dir, {
      gateUnmatched: true,
      rules: [],
      default: "main",
    });

    const { agentHandler, fileHandler, agentCalls, fileCalls } = createTestHandlers();
    const router = createRouter({ configPath, agentHandler, fileHandler });

    // First message — triggers invite
    router.route([{ type: "text", text: "first" }], { channel: "discord:456", sender: "bob" });
    await waitMicrotask();

    // Second message — should just append
    const events: string[] = [];
    router.route(
      [{ type: "text", text: "second" }],
      { channel: "discord:456", sender: "bob" },
      (e) => events.push(e.type),
    );
    await waitMicrotask();

    // Only one invite notification
    const mainCalls = agentCalls.get("main");
    assert.ok(mainCalls);
    assert.equal(mainCalls.length, 1, "should only send one invite notification");

    // Two file writes
    const fileKey = "inbox/discord-456.md";
    const fCalls = fileCalls.get(fileKey);
    assert.ok(fCalls);
    assert.equal(fCalls.length, 2, "should save both messages to file");

    // Second message emits done
    assert.ok(events.includes("done"), "should emit done for second message");
  });

  it("matched channel routes normally regardless of gateUnmatched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "router-invite-"));
    const configPath = writeConfig(dir, {
      gateUnmatched: true,
      rules: [{ channel: "web", session: "web-session" }],
      default: "main",
    });

    const { agentHandler, fileHandler, agentCalls, fileCalls } = createTestHandlers();
    const router = createRouter({ configPath, agentHandler, fileHandler });

    router.route([{ type: "text", text: "hello" }], { channel: "web", sender: "alice" });
    await waitMicrotask();

    // Should route to web-session, not gate
    const webCalls = agentCalls.get("web-session");
    assert.ok(webCalls, "should route to matched session");
    assert.equal(webCalls.length, 1);

    // No file writes
    assert.equal(fileCalls.size, 0, "should not save to file");
  });

  it("unmatched channel with gateUnmatched=false routes to default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "router-invite-"));
    const configPath = writeConfig(dir, {
      gateUnmatched: false,
      rules: [{ channel: "web", session: "web-session" }],
      default: "fallback",
    });

    const { agentHandler, fileHandler, agentCalls, fileCalls } = createTestHandlers();
    const router = createRouter({ configPath, agentHandler, fileHandler });

    router.route([{ type: "text", text: "hello" }], { channel: "discord:789", sender: "charlie" });
    await waitMicrotask();

    // Should route to default session
    const fallbackCalls = agentCalls.get("fallback");
    assert.ok(fallbackCalls, "should route to default session");
    assert.equal(fallbackCalls.length, 1);

    // No file writes
    assert.equal(fileCalls.size, 0, "should not save to file");
  });

  it("works for volute channels", async () => {
    const dir = mkdtempSync(join(tmpdir(), "router-invite-"));
    const configPath = writeConfig(dir, {
      gateUnmatched: true,
      rules: [],
    });

    const { agentHandler, fileHandler, agentCalls, fileCalls } = createTestHandlers();
    const router = createRouter({ configPath, agentHandler, fileHandler });

    router.route([{ type: "text", text: "hey there" }], {
      channel: "volute:conv-abc123",
      sender: "agent-x",
      participants: ["me", "agent-x"],
    });
    await waitMicrotask();

    const mainCalls = agentCalls.get("main");
    assert.ok(mainCalls);
    assert.equal(mainCalls.length, 1);
    const text = (mainCalls[0].content[0] as { text: string }).text;
    assert.ok(text.includes("volute:conv-abc123"));

    const fileKey = "inbox/volute-conv-abc123.md";
    assert.ok(fileCalls.has(fileKey), "should save to sanitized file path");
  });

  it("includes participant info and batch hint for group channels", async () => {
    const dir = mkdtempSync(join(tmpdir(), "router-invite-"));
    const configPath = writeConfig(dir, {
      gateUnmatched: true,
      rules: [],
    });

    const { agentHandler, fileHandler, agentCalls } = createTestHandlers();
    const router = createRouter({ configPath, agentHandler, fileHandler });

    router.route([{ type: "text", text: "group message" }], {
      channel: "discord:general",
      sender: "alice",
      platform: "discord",
      serverName: "My Server",
      channelName: "general",
      participants: ["alice", "bob", "charlie"],
      participantCount: 4, // 3 others + self
    });
    await waitMicrotask();

    const mainCalls = agentCalls.get("main")!;
    const text = (mainCalls[0].content[0] as { text: string }).text;
    assert.ok(text.includes("Platform: discord"));
    assert.ok(text.includes("Server: My Server"));
    assert.ok(text.includes("alice, bob, charlie"));
    assert.ok(text.includes('"batch": 5'), "should suggest batch mode for group channels");
    assert.ok(text.includes("3 other participants"), "should mention participant count");
  });

  it("does not suggest batch for DM channels", async () => {
    const dir = mkdtempSync(join(tmpdir(), "router-invite-"));
    const configPath = writeConfig(dir, {
      gateUnmatched: true,
      rules: [],
    });

    const { agentHandler, fileHandler, agentCalls } = createTestHandlers();
    const router = createRouter({ configPath, agentHandler, fileHandler });

    router.route([{ type: "text", text: "hey" }], {
      channel: "volute:dm-123",
      sender: "alice",
      participantCount: 2,
    });
    await waitMicrotask();

    const mainCalls = agentCalls.get("main")!;
    const text = (mainCalls[0].content[0] as { text: string }).text;
    assert.ok(!text.includes("batch"), "should not suggest batch for DMs");
  });

  it("includes channel send command in invite notification", async () => {
    const dir = mkdtempSync(join(tmpdir(), "router-invite-"));
    const configPath = writeConfig(dir, {
      gateUnmatched: true,
      rules: [],
    });

    const { agentHandler, fileHandler, agentCalls } = createTestHandlers();
    const router = createRouter({ configPath, agentHandler, fileHandler });

    router.route([{ type: "text", text: "hello" }], {
      channel: "discord:general",
      sender: "alice",
    });
    await waitMicrotask();

    const mainCalls = agentCalls.get("main")!;
    const text = (mainCalls[0].content[0] as { text: string }).text;
    assert.ok(
      text.includes("volute channel send discord:general"),
      "should include channel send command",
    );
  });

  it("uses conversation send for volute channels in invite", async () => {
    const dir = mkdtempSync(join(tmpdir(), "router-invite-"));
    const configPath = writeConfig(dir, {
      gateUnmatched: true,
      rules: [],
    });

    const { agentHandler, fileHandler, agentCalls } = createTestHandlers();
    const router = createRouter({ configPath, agentHandler, fileHandler });

    router.route([{ type: "text", text: "hi" }], {
      channel: "volute:conv-xyz",
      sender: "alice",
    });
    await waitMicrotask();

    const mainCalls = agentCalls.get("main")!;
    const text = (mainCalls[0].content[0] as { text: string }).text;
    assert.ok(
      text.includes("volute conversation send conv-xyz"),
      "should use conversation send for volute channels",
    );
    assert.ok(
      !text.includes("volute channel send"),
      "should not suggest channel send for volute channels",
    );
  });

  it("gating works without fileHandler configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "router-invite-"));
    const configPath = writeConfig(dir, {
      gateUnmatched: true,
      rules: [],
    });

    const { agentHandler, agentCalls } = createTestHandlers();
    // No fileHandler provided
    const router = createRouter({ configPath, agentHandler });

    const events: string[] = [];
    router.route(
      [{ type: "text", text: "hello" }],
      { channel: "telegram:group1", sender: "dave" },
      (e) => events.push(e.type),
    );
    await waitMicrotask();

    // Should still send invite notification
    const mainCalls = agentCalls.get("main");
    assert.ok(mainCalls, "should send invite even without fileHandler");
  });
});
