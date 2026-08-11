import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createRouter } from "../templates/_base/src/lib/router.js";
import type { HandlerMeta, Listener, VoluteContentPart } from "../templates/_base/src/lib/types.js";

// The daemon delivery manager is the sole router now — it resolves the route, session,
// gating, mention filtering, and batching before it ever calls the mind. These tests pin
// the only behavior the slimmed template keeps: how dispatch()/dispatchBatch() *format* an
// already-routed message (prefix, typing suffix, session reply/instruction handling).

type HandlerCall = {
  session: string;
  content: VoluteContentPart[];
  meta: HandlerMeta;
  hadListener: boolean;
};

function createTestHandler() {
  const calls: HandlerCall[] = [];
  const mindHandler = (session: string) => ({
    handle(content: VoluteContentPart[], meta: HandlerMeta, listener?: Listener) {
      calls.push({ session, content, meta, hadListener: listener !== undefined });
      queueMicrotask(() => listener?.({ type: "done", messageId: meta.messageId }));
      return () => {};
    },
  });
  return { mindHandler, calls };
}

function textOf(content: VoluteContentPart[]): string {
  const part = content.find((p) => p.type === "text");
  return part ? (part as { text: string }).text : "";
}

function writeConfig(config: object): string {
  const dir = mkdtempSync(join(tmpdir(), "router-dispatch-"));
  const path = join(dir, "routes.json");
  writeFileSync(path, JSON.stringify(config));
  return path;
}

describe("dispatch formatting", () => {
  it("prepends the channel/sender/time prefix to the first text part", () => {
    const { mindHandler, calls } = createTestHandler();
    const router = createRouter({ mindHandler });

    router.dispatch([{ type: "text", text: "hello there" }], "main", {
      channel: "discord:123",
      sender: "alice",
      platform: "discord",
      channelName: "general",
    });

    assert.equal(calls.length, 1);
    const text = textOf(calls[0].content);
    assert.match(text, /^\[discord: alice in #general — \d{4}-\d{2}-\d{2} \d{2}:\d{2}\]\n/);
    assert.ok(text.includes("hello there"));
  });

  it("shows the thread name in the prefix for a non-main session", () => {
    const { mindHandler, calls } = createTestHandler();
    const router = createRouter({ mindHandler });

    router.dispatch([{ type: "text", text: "hi" }], "alice", { channel: "web", sender: "alice" });

    assert.match(textOf(calls[0].content), /— thread: alice —/);
  });

  it("appends the typing suffix after the last text part", () => {
    const { mindHandler, calls } = createTestHandler();
    const router = createRouter({ mindHandler });

    router.dispatch([{ type: "text", text: "body" }], "main", {
      channel: "web",
      sender: "bob",
      typing: ["carol"],
    });

    assert.ok(textOf(calls[0].content).endsWith("\n[carol is typing]"));
  });

  it("carries the session's replyInstructions through to the handler meta", () => {
    const configPath = writeConfig({ threads: { main: { replyInstructions: "always" } } });
    const { mindHandler, calls } = createTestHandler();
    const router = createRouter({ configPath, mindHandler });

    router.dispatch([{ type: "text", text: "x" }], "main", { channel: "web", sender: "a" });

    assert.equal(calls[0].meta.replyInstructions, "always");
  });

  it("defaults replyInstructions to 'once' with no thread config", () => {
    const { mindHandler, calls } = createTestHandler();
    const router = createRouter({ mindHandler });

    router.dispatch([{ type: "text", text: "x" }], "main", { channel: "web", sender: "a" });

    assert.equal(calls[0].meta.replyInstructions, "once");
  });

  it("prepends session instructions only on the first message per session", () => {
    const configPath = writeConfig({ threads: { main: { instructions: "Be brief." } } });
    const { mindHandler, calls } = createTestHandler();
    const router = createRouter({ configPath, mindHandler });

    router.dispatch([{ type: "text", text: "first" }], "main", { channel: "web", sender: "a" });
    router.dispatch([{ type: "text", text: "second" }], "main", { channel: "web", sender: "a" });

    assert.ok(textOf(calls[0].content).includes("[Session instructions: Be brief.]"));
    assert.ok(
      !textOf(calls[1].content).includes("[Session instructions:"),
      "instructions must not repeat on the second message",
    );
  });

  it("re-prepends instructions on every ephemeral $new (new-*) dispatch", () => {
    const configPath = writeConfig({ threads: { "new-*": { instructions: "Fresh start." } } });
    const { mindHandler, calls } = createTestHandler();
    const router = createRouter({ configPath, mindHandler });

    router.dispatch([{ type: "text", text: "a" }], "new-111", { channel: "web", sender: "x" });
    router.dispatch([{ type: "text", text: "b" }], "new-222", { channel: "web", sender: "x" });

    assert.ok(textOf(calls[0].content).includes("[Session instructions: Fresh start.]"));
    assert.ok(textOf(calls[1].content).includes("[Session instructions: Fresh start.]"));
  });

  it("resolves interrupt from session config, with meta.interrupt overriding", () => {
    const configPath = writeConfig({ threads: { main: { interrupt: true } } });
    const { mindHandler, calls } = createTestHandler();
    const router = createRouter({ configPath, mindHandler });

    router.dispatch([{ type: "text", text: "a" }], "main", { channel: "web", sender: "x" });
    assert.equal(calls[0].meta.interrupt, true, "falls back to the session config");

    router.dispatch([{ type: "text", text: "b" }], "main", {
      channel: "web",
      sender: "x",
      interrupt: false,
    });
    assert.equal(calls[1].meta.interrupt, false, "meta.interrupt wins over config");
  });

  it("passes no listener to the handler on a fire-and-forget dispatch (#459)", () => {
    const { mindHandler, calls } = createTestHandler();
    const router = createRouter({ mindHandler });

    router.dispatch([{ type: "text", text: "hi" }], "main", { channel: "web" });

    assert.equal(calls[0].hadListener, false);
  });

  it("passes the listener through when one is provided", () => {
    const { mindHandler, calls } = createTestHandler();
    const router = createRouter({ mindHandler });

    router.dispatch([{ type: "text", text: "hi" }], "main", { channel: "web" }, () => {});

    assert.equal(calls[0].hadListener, true);
  });
});

describe("dispatchBatch formatting", () => {
  it("renders a single-channel batch header and per-message sender prefixes", () => {
    const { mindHandler, calls } = createTestHandler();
    const router = createRouter({ mindHandler });

    router.dispatchBatch(
      {
        channels: {
          web: [
            { sender: "alice", content: "hi" },
            { sender: "bob", content: "yo" },
          ],
        },
      },
      "main",
      {},
    );

    const text = textOf(calls[0].content);
    assert.ok(text.startsWith("[Batch: 2 messages from web]"));
    assert.match(text, /\[alice — \d{2}:\d{2}\]\nhi/);
    assert.match(text, /\[bob — \d{2}:\d{2}\]\nyo/);
  });

  it("labels each message with its channel when a batch spans channels", () => {
    const { mindHandler, calls } = createTestHandler();
    const router = createRouter({ mindHandler });

    router.dispatchBatch(
      {
        channels: {
          web: [{ sender: "alice", content: "hi" }],
          "discord:1": [{ sender: "bob", content: "yo" }],
        },
      },
      "main",
      {},
    );

    const text = textOf(calls[0].content);
    assert.ok(text.startsWith("[Batch: 2 messages — 1 from web, 1 from discord:1]"));
    assert.match(text, /\[alice in web — \d{2}:\d{2}\]/);
    assert.match(text, /\[bob in discord:1 — \d{2}:\d{2}\]/);
  });

  it("prepends session instructions once for a batch", () => {
    const configPath = writeConfig({ threads: { main: { instructions: "Batched." } } });
    const { mindHandler, calls } = createTestHandler();
    const router = createRouter({ configPath, mindHandler });

    router.dispatchBatch({ channels: { web: [{ sender: "a", content: "x" }] } }, "main", {});

    assert.ok(textOf(calls[0].content).includes("[Session instructions: Batched.]"));
  });

  it("does nothing for an empty batch", () => {
    const { mindHandler, calls } = createTestHandler();
    const router = createRouter({ mindHandler });

    router.dispatchBatch({ channels: {} }, "main", {});

    assert.equal(calls.length, 0);
  });
});
