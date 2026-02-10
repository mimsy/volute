import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createRouter } from "../templates/_base/src/lib/router.js";
import type {
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
  meta: { channel?: string; sender?: string },
): Promise<VoluteEvent[]> {
  return new Promise((resolve) => {
    const events: VoluteEvent[] = [];
    router.route(content, meta, (event) => {
      events.push(event);
      if (event.type === "done") resolve(events);
    });
  });
}

describe("router", () => {
  it("routes to agent handler with default session", async () => {
    const agent = mockAgentHandler();
    const router = createRouter({ agentHandler: agent.resolver });

    await waitForDone(router, [{ type: "text", text: "hi" }], { channel: "web" });

    assert.equal(agent.calls.length, 1);
    assert.equal(agent.calls[0].sessionName, "main");
  });

  it("routes to file handler when configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "router-test-"));
    const configPath = join(dir, "sessions.json");
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
      agentHandler: agent.resolver,
      fileHandler: file.resolver,
    });

    await waitForDone(router, [{ type: "text", text: "log entry" }], { channel: "discord:logs" });

    assert.equal(file.calls.length, 1);
    assert.equal(file.calls[0].path, "inbox/log.md");
    assert.equal(agent.calls.length, 0);
  });

  it("emits done and discards when file destination but no fileHandler", async () => {
    const dir = mkdtempSync(join(tmpdir(), "router-test-"));
    const configPath = join(dir, "sessions.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        rules: [{ channel: "discord:*", destination: "file", path: "inbox/log.md" }],
      }),
    );

    const agent = mockAgentHandler();
    const router = createRouter({ configPath, agentHandler: agent.resolver });

    const events = await waitForDone(router, [{ type: "text", text: "msg" }], {
      channel: "discord:123",
    });

    assert.equal(events.length, 1);
    assert.equal(events[0].type, "done");
    assert.equal(agent.calls.length, 0);
  });

  it("expands $new session to unique name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "router-test-"));
    const configPath = join(dir, "sessions.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        rules: [{ channel: "system:*", session: "$new" }],
      }),
    );

    const agent = mockAgentHandler();
    const router = createRouter({ configPath, agentHandler: agent.resolver });

    await waitForDone(router, [{ type: "text", text: "a" }], { channel: "system:scheduler" });
    await waitForDone(router, [{ type: "text", text: "b" }], { channel: "system:scheduler" });

    assert.equal(agent.calls.length, 2);
    assert.ok(agent.calls[0].sessionName.startsWith("new-"));
    assert.ok(agent.calls[1].sessionName.startsWith("new-"));
    assert.notEqual(agent.calls[0].sessionName, agent.calls[1].sessionName);
  });

  it("batch buffers messages and flushes on timer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "router-test-"));
    const configPath = join(dir, "sessions.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        rules: [{ channel: "discord:*", session: "batch-test", batch: 0.001 }], // ~60ms
      }),
    );

    const agent = mockAgentHandler();
    const router = createRouter({ configPath, agentHandler: agent.resolver });

    // Route two messages — they should be buffered, not sent immediately
    router.route([{ type: "text", text: "msg1" }], { channel: "discord:123", sender: "alice" });
    router.route([{ type: "text", text: "msg2" }], { channel: "discord:123", sender: "bob" });

    assert.equal(agent.calls.length, 0, "messages should be buffered");

    // Wait for timer to flush
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(agent.calls.length, 1, "batch should be flushed");
    assert.equal(agent.calls[0].sessionName, "batch-test");

    // Content should contain batch header
    const text = agent.calls[0].content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
    assert.ok(text.includes("[Batch:"), "should have batch header");
    assert.ok(text.includes("msg1"));
    assert.ok(text.includes("msg2"));

    router.close();
  });

  it("flush on close sends buffered batch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "router-test-"));
    const configPath = join(dir, "sessions.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        rules: [{ channel: "discord:*", session: "close-test", batch: 60 }], // long timer
      }),
    );

    const agent = mockAgentHandler();
    const router = createRouter({ configPath, agentHandler: agent.resolver });

    router.route([{ type: "text", text: "buffered msg" }], {
      channel: "discord:123",
      sender: "alice",
    });
    assert.equal(agent.calls.length, 0);

    router.close();
    assert.equal(agent.calls.length, 1, "close should flush pending batches");
  });
});
