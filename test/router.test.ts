import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createRouter } from "../templates/_base/src/lib/router.js";
import type {
  ChannelMeta,
  HandlerMeta,
  HandlerResolver,
  MessageHandler,
  VoluteContentPart,
  VoluteEvent,
} from "../templates/_base/src/lib/types.js";

function mockAgentHandler(): {
  resolver: HandlerResolver;
  calls: { sessionName: string; content: VoluteContentPart[]; meta: HandlerMeta }[];
} {
  const calls: { sessionName: string; content: VoluteContentPart[]; meta: HandlerMeta }[] = [];
  const resolver: HandlerResolver = (sessionName: string): MessageHandler => ({
    handle(content, meta, listener) {
      calls.push({ sessionName, content, meta });
      // Emit done async
      queueMicrotask(() => listener({ type: "done", messageId: meta.messageId }));
      return () => {};
    },
  });
  return { resolver, calls };
}

function mockFileHandler(): {
  resolver: HandlerResolver;
  calls: { path: string; content: VoluteContentPart[] }[];
} {
  const calls: { path: string; content: VoluteContentPart[] }[] = [];
  const resolver: HandlerResolver = (path: string): MessageHandler => ({
    handle(content, meta, listener) {
      calls.push({ path, content });
      queueMicrotask(() => listener({ type: "done", messageId: meta.messageId }));
      return () => {};
    },
  });
  return { resolver, calls };
}

function waitForDone(
  router: ReturnType<typeof createRouter>,
  content: VoluteContentPart[],
  meta: ChannelMeta,
): Promise<VoluteEvent[]> {
  return new Promise((resolve) => {
    const events: VoluteEvent[] = [];
    router.route(content, meta, (event) => {
      events.push(event);
      if (event.type === "done") resolve(events);
    });
  });
}

function batchText(calls: { content: VoluteContentPart[] }[]): string {
  return calls
    .flatMap((c) => c.content)
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

describe("router", () => {
  it("routes to agent handler with default session", async () => {
    const agent = mockAgentHandler();
    const router = createRouter({ mindHandler: agent.resolver });

    await waitForDone(router, [{ type: "text", text: "hi" }], { channel: "web" });

    assert.equal(agent.calls.length, 1);
    assert.equal(agent.calls[0].sessionName, "main");
  });

  it("routes to file handler when configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "router-test-"));
    const configPath = join(dir, "routes.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        rules: [{ channel: "discord:logs", destination: "file", path: "inbox/log.md" }],
      }),
    );

    const agent = mockAgentHandler();
    const file = mockFileHandler();
    const router = createRouter({
      configPath,
      mindHandler: agent.resolver,
      fileHandler: file.resolver,
    });

    await waitForDone(router, [{ type: "text", text: "log entry" }], { channel: "discord:logs" });

    assert.equal(file.calls.length, 1);
    assert.equal(file.calls[0].path, "inbox/log.md");
    assert.equal(agent.calls.length, 0);
  });

  it("emits done and discards when file destination but no fileHandler", async () => {
    const dir = mkdtempSync(join(tmpdir(), "router-test-"));
    const configPath = join(dir, "routes.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        rules: [{ channel: "discord:*", destination: "file", path: "inbox/log.md" }],
      }),
    );

    const agent = mockAgentHandler();
    const router = createRouter({ configPath, mindHandler: agent.resolver });

    const events = await waitForDone(router, [{ type: "text", text: "msg" }], {
      channel: "discord:123",
    });

    assert.equal(events.length, 1);
    assert.equal(events[0].type, "done");
    assert.equal(agent.calls.length, 0);
  });

  it("expands $new session to unique name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "router-test-"));
    const configPath = join(dir, "routes.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        rules: [{ channel: "system:*", session: "$new" }],
      }),
    );

    const agent = mockAgentHandler();
    const router = createRouter({ configPath, mindHandler: agent.resolver });

    await waitForDone(router, [{ type: "text", text: "a" }], { channel: "system:scheduler" });
    await waitForDone(router, [{ type: "text", text: "b" }], { channel: "system:scheduler" });

    assert.equal(agent.calls.length, 2);
    assert.ok(agent.calls[0].sessionName.startsWith("new-"));
    assert.ok(agent.calls[1].sessionName.startsWith("new-"));
    assert.notEqual(agent.calls[0].sessionName, agent.calls[1].sessionName);
  });

  it("batch (number) buffers messages and flushes on maxWait", async () => {
    const dir = mkdtempSync(join(tmpdir(), "router-test-"));
    const configPath = join(dir, "routes.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        rules: [{ channel: "discord:*", session: "batch-test" }],
        sessions: { "batch-test": { batch: 0.001 } }, // ~60ms maxWait
      }),
    );

    const agent = mockAgentHandler();
    const router = createRouter({ configPath, mindHandler: agent.resolver });

    // Route two messages — they should be buffered, not sent immediately
    router.route([{ type: "text", text: "msg1" }], { channel: "discord:123", sender: "alice" });
    router.route([{ type: "text", text: "msg2" }], { channel: "discord:123", sender: "bob" });

    assert.equal(agent.calls.length, 0, "messages should be buffered");

    // Wait for timer to flush
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(agent.calls.length, 1, "batch should be flushed");
    assert.equal(agent.calls[0].sessionName, "batch-test");

    const text = batchText(agent.calls);
    assert.ok(text.includes("[Batch:"), "should have batch header");
    assert.ok(text.includes("msg1"));
    assert.ok(text.includes("msg2"));

    router.close();
  });

  it("flush on close sends buffered batch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "router-test-"));
    const configPath = join(dir, "routes.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        rules: [{ channel: "discord:*", session: "close-test" }],
        sessions: { "close-test": { batch: 60 } }, // long timer
      }),
    );

    const agent = mockAgentHandler();
    const router = createRouter({ configPath, mindHandler: agent.resolver });

    router.route([{ type: "text", text: "buffered msg" }], {
      channel: "discord:123",
      sender: "alice",
    });
    assert.equal(agent.calls.length, 0);

    router.close();
    assert.equal(agent.calls.length, 1, "close should flush pending batches");
  });

  // --- Debounce ---

  it("debounce flushes after quiet period", async () => {
    const dir = mkdtempSync(join(tmpdir(), "router-test-"));
    const configPath = join(dir, "routes.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        rules: [{ channel: "discord:*", session: "debounce-test" }],
        sessions: { "debounce-test": { batch: { debounce: 0.08 } } }, // 80ms
      }),
    );

    const agent = mockAgentHandler();
    const router = createRouter({ configPath, mindHandler: agent.resolver });

    router.route([{ type: "text", text: "msg1" }], { channel: "discord:123", sender: "alice" });
    assert.equal(agent.calls.length, 0);

    // Send another message before debounce fires — should reset the timer
    await new Promise((r) => setTimeout(r, 40));
    router.route([{ type: "text", text: "msg2" }], { channel: "discord:123", sender: "bob" });
    assert.equal(agent.calls.length, 0, "debounce should reset on new message");

    // Wait for debounce to fire after msg2
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(agent.calls.length, 1, "debounce should flush after quiet period");

    const text = batchText(agent.calls);
    assert.ok(text.includes("msg1"));
    assert.ok(text.includes("msg2"));

    router.close();
  });

  it("maxWait forces flush even with continuous messages", async () => {
    const dir = mkdtempSync(join(tmpdir(), "router-test-"));
    const configPath = join(dir, "routes.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        rules: [{ channel: "discord:*", session: "maxwait-test" }],
        sessions: {
          "maxwait-test": { batch: { debounce: 5, maxWait: 0.1 } }, // 5s debounce, 100ms maxWait
        },
      }),
    );

    const agent = mockAgentHandler();
    const router = createRouter({ configPath, mindHandler: agent.resolver });

    // Send messages rapidly — debounce would keep resetting, but maxWait should force flush
    router.route([{ type: "text", text: "msg1" }], { channel: "discord:123", sender: "alice" });

    await new Promise((r) => setTimeout(r, 50));
    router.route([{ type: "text", text: "msg2" }], { channel: "discord:123", sender: "bob" });

    // maxWait of 100ms should fire (debounce at 5s won't have fired)
    await new Promise((r) => setTimeout(r, 100));

    assert.equal(agent.calls.length, 1, "maxWait should force flush");
    const text = batchText(agent.calls);
    assert.ok(text.includes("msg1"));
    assert.ok(text.includes("msg2"));

    router.close();
  });

  // --- Triggers ---

  it("trigger causes immediate flush", async () => {
    const dir = mkdtempSync(join(tmpdir(), "router-test-"));
    const configPath = join(dir, "routes.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        rules: [{ channel: "discord:*", session: "trigger-test" }],
        sessions: {
          "trigger-test": {
            batch: { debounce: 60, maxWait: 300, triggers: ["@agent"] },
          },
        },
      }),
    );

    const agent = mockAgentHandler();
    const router = createRouter({ configPath, mindHandler: agent.resolver });

    // First message doesn't trigger
    router.route([{ type: "text", text: "hello everyone" }], {
      channel: "discord:123",
      sender: "alice",
    });
    assert.equal(agent.calls.length, 0, "non-trigger message should be buffered");

    // Second message contains trigger
    router.route([{ type: "text", text: "hey @agent what do you think?" }], {
      channel: "discord:123",
      sender: "bob",
    });
    assert.equal(agent.calls.length, 1, "trigger should flush immediately");

    const text = batchText(agent.calls);
    assert.ok(text.includes("hello everyone"), "should include buffered message");
    assert.ok(text.includes("@agent"), "should include trigger message");

    router.close();
  });

  it("trigger matching is case-insensitive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "router-test-"));
    const configPath = join(dir, "routes.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        rules: [{ channel: "discord:*", session: "trigger-ci" }],
        sessions: {
          "trigger-ci": { batch: { debounce: 60, triggers: ["@Agent"] } },
        },
      }),
    );

    const agent = mockAgentHandler();
    const router = createRouter({ configPath, mindHandler: agent.resolver });

    router.route([{ type: "text", text: "hey @AGENT help" }], {
      channel: "discord:123",
      sender: "alice",
    });
    assert.equal(agent.calls.length, 1, "trigger should match case-insensitively");

    router.close();
  });

  it("batch with only triggers and no debounce/maxWait flushes immediately on trigger", async () => {
    const dir = mkdtempSync(join(tmpdir(), "router-test-"));
    const configPath = join(dir, "routes.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        rules: [{ channel: "discord:*", session: "trigger-only" }],
        sessions: {
          "trigger-only": { batch: { triggers: ["urgent"] } },
        },
      }),
    );

    const agent = mockAgentHandler();
    const router = createRouter({ configPath, mindHandler: agent.resolver });

    // Non-trigger — no debounce or maxWait configured, so flushes immediately
    router.route([{ type: "text", text: "casual message" }], {
      channel: "discord:123",
      sender: "alice",
    });
    // With no debounce and no maxWait, the scheduleBatchTimers falls through to immediate flush
    assert.equal(agent.calls.length, 1, "should flush immediately when no timers configured");

    // Trigger message also flushes immediately
    router.route([{ type: "text", text: "urgent issue!" }], {
      channel: "discord:123",
      sender: "bob",
    });
    assert.equal(agent.calls.length, 2, "trigger should also flush immediately");

    router.close();
  });

  it("batch header includes channel URI alongside display name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "router-test-"));
    const configPath = join(dir, "routes.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        rules: [{ channel: "discord:*", session: "uri-test" }],
        sessions: {
          "uri-test": { batch: { debounce: 60, triggers: ["flush"] } },
        },
      }),
    );

    const agent = mockAgentHandler();
    const router = createRouter({ configPath, mindHandler: agent.resolver });

    // Send with channelName (human-readable) — URI should still appear
    router.route([{ type: "text", text: "hello" }], {
      channel: "discord:123",
      sender: "alice",
      channelName: "general",
      serverName: "My Server",
    });
    assert.equal(agent.calls.length, 0, "first message should be buffered (no trigger)");

    // Second message triggers flush — both messages delivered together
    router.route([{ type: "text", text: "flush please" }], {
      channel: "discord:123",
      sender: "bob",
      channelName: "general",
      serverName: "My Server",
    });

    assert.equal(agent.calls.length, 1, "trigger should flush both messages");
    const text = batchText(agent.calls);
    assert.ok(text.includes("discord:123"), "batch header should include channel URI");
    assert.ok(text.includes("#general"), "batch header should include channel display name");
    assert.ok(text.includes("hello"), "should include first message");
    assert.ok(text.includes("flush"), "should include trigger message");

    router.close();
  });

  // --- Typing indicators ---

  it("direct dispatch appends typing suffix for single user", async () => {
    const dir = mkdtempSync(join(tmpdir(), "router-test-"));
    const configPath = join(dir, "routes.json");
    writeFileSync(configPath, JSON.stringify({ rules: [{ channel: "web", session: "main" }] }));

    const agent = mockAgentHandler();
    const router = createRouter({ configPath, mindHandler: agent.resolver });

    await waitForDone(router, [{ type: "text", text: "hello" }], {
      channel: "web",
      sender: "alice",
      typing: ["bob"],
    });

    assert.equal(agent.calls.length, 1);
    const text = batchText(agent.calls);
    assert.ok(text.includes("[bob is typing]"), "should show single user typing");
  });

  it("direct dispatch appends typing suffix for multiple users", async () => {
    const dir = mkdtempSync(join(tmpdir(), "router-test-"));
    const configPath = join(dir, "routes.json");
    writeFileSync(configPath, JSON.stringify({ rules: [{ channel: "web", session: "main" }] }));

    const agent = mockAgentHandler();
    const router = createRouter({ configPath, mindHandler: agent.resolver });

    await waitForDone(router, [{ type: "text", text: "hello" }], {
      channel: "web",
      sender: "alice",
      typing: ["bob", "charlie"],
    });

    assert.equal(agent.calls.length, 1);
    const text = batchText(agent.calls);
    assert.ok(text.includes("[bob, charlie are typing]"), "should show multiple users typing");
  });

  it("direct dispatch omits typing suffix when no one is typing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "router-test-"));
    const configPath = join(dir, "routes.json");
    writeFileSync(configPath, JSON.stringify({ rules: [{ channel: "web", session: "main" }] }));

    const agent = mockAgentHandler();
    const router = createRouter({ configPath, mindHandler: agent.resolver });

    await waitForDone(router, [{ type: "text", text: "hello" }], {
      channel: "web",
      sender: "alice",
      typing: [],
    });

    assert.equal(agent.calls.length, 1);
    const text = batchText(agent.calls);
    assert.ok(!text.includes("typing"), "should not include typing indicator");
  });

  it("passes autoReply to handler meta when session config has autoReply: true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "router-test-"));
    const configPath = join(dir, "routes.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        rules: [{ channel: "discord:*", session: "discord" }],
        sessions: { discord: { autoReply: true } },
      }),
    );

    const agent = mockAgentHandler();
    const router = createRouter({ configPath, mindHandler: agent.resolver });

    await waitForDone(router, [{ type: "text", text: "hello" }], { channel: "discord:general" });

    assert.equal(agent.calls.length, 1);
    assert.equal(agent.calls[0].meta.autoReply, true);
    assert.equal(agent.calls[0].sessionName, "discord");
  });

  it("defaults autoReply to false when no session config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "router-test-"));
    const configPath = join(dir, "routes.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        rules: [{ channel: "web", session: "main" }],
      }),
    );

    const agent = mockAgentHandler();
    const router = createRouter({ configPath, mindHandler: agent.resolver });

    await waitForDone(router, [{ type: "text", text: "hello" }], { channel: "web" });

    assert.equal(agent.calls.length, 1);
    assert.equal(agent.calls[0].meta.autoReply, false);
  });

  it("autoReply from session config does not affect routing match behavior", async () => {
    const dir = mkdtempSync(join(tmpdir(), "router-test-"));
    const configPath = join(dir, "routes.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        rules: [
          { channel: "discord:*", session: "discord" },
          { channel: "slack:*", session: "slack" },
        ],
        sessions: { discord: { autoReply: true } },
      }),
    );

    const agent = mockAgentHandler();
    const router = createRouter({ configPath, mindHandler: agent.resolver });

    await waitForDone(router, [{ type: "text", text: "hi" }], { channel: "discord:general" });
    await waitForDone(router, [{ type: "text", text: "hi" }], { channel: "slack:random" });

    assert.equal(agent.calls.length, 2);
    assert.equal(agent.calls[0].meta.autoReply, true);
    assert.equal(agent.calls[1].meta.autoReply, false);
  });

  it("batch mode includes typing from last message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "router-test-"));
    const configPath = join(dir, "routes.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        rules: [{ channel: "discord:*", session: "typing-batch" }],
        sessions: {
          "typing-batch": { batch: { debounce: 60, triggers: ["flush"] } },
        },
      }),
    );

    const agent = mockAgentHandler();
    const router = createRouter({ configPath, mindHandler: agent.resolver });

    router.route([{ type: "text", text: "msg1" }], {
      channel: "discord:123",
      sender: "alice",
      typing: ["bob"],
    });
    router.route([{ type: "text", text: "flush" }], {
      channel: "discord:123",
      sender: "bob",
      typing: ["charlie"],
    });

    assert.equal(agent.calls.length, 1);
    const text = batchText(agent.calls);
    assert.ok(text.includes("[charlie is typing]"), "batch should use typing from last message");
    assert.ok(
      !text.includes("[bob is typing]"),
      "batch should not use typing from earlier messages",
    );

    router.close();
  });

  it("prepends session instructions to direct dispatch content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "router-test-"));
    const configPath = join(dir, "routes.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        rules: [{ channel: "discord:*", session: "discord" }],
        sessions: { discord: { instructions: "Brief responses only." } },
      }),
    );

    const agent = mockAgentHandler();
    const router = createRouter({ configPath, mindHandler: agent.resolver });

    await waitForDone(router, [{ type: "text", text: "hello" }], { channel: "discord:general" });

    assert.equal(agent.calls.length, 1);
    const text = batchText(agent.calls);
    assert.ok(
      text.includes("[Session instructions: Brief responses only.]"),
      "should prepend session instructions",
    );
    assert.ok(text.includes("hello"), "should still include original message");
  });
});
