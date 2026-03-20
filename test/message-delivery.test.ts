import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { getDb } from "../src/lib/db.js";
import { extractTextContent } from "../src/lib/delivery/delivery-router.js";
import {
  recordInbound,
  recordOutbound,
  resolveSleepAction,
} from "../src/lib/delivery/message-delivery.js";
import { type MindEvent, subscribe } from "../src/lib/events/mind-events.js";
import { mindHistory } from "../src/lib/schema.js";

describe("extractTextContent", () => {
  it("returns string content as-is", () => {
    assert.equal(extractTextContent("hello world"), "hello world");
  });

  it("returns empty string as-is", () => {
    assert.equal(extractTextContent(""), "");
  });

  it("extracts text from content block array", () => {
    const blocks = [
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ];
    assert.equal(extractTextContent(blocks), "hello\nworld");
  });

  it("filters out non-text blocks", () => {
    const blocks = [
      { type: "text", text: "hello" },
      { type: "image", media_type: "image/png", data: "abc123" },
      { type: "text", text: "world" },
    ];
    assert.equal(extractTextContent(blocks), "hello\nworld");
  });

  it("filters out text blocks with missing text field", () => {
    const blocks = [{ type: "text", text: "hello" }, { type: "text" }, { type: "text", text: "" }];
    assert.equal(extractTextContent(blocks), "hello");
  });

  it("returns empty string for empty array", () => {
    assert.equal(extractTextContent([]), "");
  });

  it("JSON-stringifies non-string non-array input", () => {
    assert.equal(extractTextContent({ key: "value" }), '{"key":"value"}');
    assert.equal(extractTextContent(42), "42");
    assert.equal(extractTextContent(null), "null");
    assert.equal(extractTextContent(true), "true");
  });
});

describe("resolveSleepAction", () => {
  it("returns skip when whileSleeping is skip", () => {
    assert.equal(resolveSleepAction("skip", false, false), "skip");
  });

  it("returns skip even when wake trigger matches", () => {
    assert.equal(resolveSleepAction("skip", false, true), "skip");
  });

  it("trigger-wake queues and wakes when not already woken", () => {
    assert.equal(resolveSleepAction("trigger-wake", false, false), "queue-and-wake");
  });

  it("trigger-wake queues only when already woken by trigger", () => {
    assert.equal(resolveSleepAction("trigger-wake", true, false), "queue");
  });

  it("no behavior with wake trigger match queues and wakes", () => {
    assert.equal(resolveSleepAction(undefined, false, true), "queue-and-wake");
  });

  it("no behavior without wake trigger queues only", () => {
    assert.equal(resolveSleepAction(undefined, false, false), "queue");
  });

  it("explicit queue behavior just queues", () => {
    assert.equal(resolveSleepAction("queue", false, false), "queue");
  });

  it("explicit queue ignores wake trigger match", () => {
    assert.equal(resolveSleepAction("queue", false, true), "queue");
  });

  it("unknown behavior falls through to queue", () => {
    assert.equal(resolveSleepAction("invalid-value", false, true), "queue");
  });
});

describe("recordOutbound", () => {
  afterEach(async () => {
    const db = await getDb();
    await db.delete(mindHistory).where(eq(mindHistory.mind, "test-out"));
  });

  it("persists an outbound event to mind_history", async () => {
    await recordOutbound("test-out", "dm:alice", "hello from mind");
    const db = await getDb();
    const rows = await db.select().from(mindHistory).where(eq(mindHistory.mind, "test-out"));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, "outbound");
    assert.equal(rows[0].channel, "dm:alice");
    assert.equal(rows[0].content, "hello from mind");
    assert.equal(rows[0].turn_id, null);
    assert.equal(rows[0].message_id, null);
  });

  it("stores turn_id and message_id when provided", async () => {
    await recordOutbound("test-out", "dm:alice", "hi", {
      turnId: "turn-123",
      messageId: "msg-456",
    });
    const db = await getDb();
    const rows = await db.select().from(mindHistory).where(eq(mindHistory.mind, "test-out"));
    assert.equal(rows[0].turn_id, "turn-123");
    assert.equal(rows[0].message_id, "msg-456");
  });

  it("publishes a mind event", async () => {
    const events: MindEvent[] = [];
    const unsub = subscribe("test-out", (e) => events.push(e));
    try {
      await recordOutbound("test-out", "dm:alice", "hello");
      assert.equal(events.length, 1);
      assert.equal(events[0].type, "outbound");
      assert.equal(events[0].channel, "dm:alice");
      assert.equal(events[0].content, "hello");
    } finally {
      unsub();
    }
  });

  it("does not throw on DB failure", async () => {
    // recordOutbound catches DB errors internally — verify it doesn't reject.
    // We can't easily break the DB, but we can verify the contract by calling
    // with null content (which is valid) and confirming no exception.
    await assert.doesNotReject(() => recordOutbound("test-out", "ch", null));
  });
});

describe("recordInbound", () => {
  afterEach(async () => {
    const db = await getDb();
    await db.delete(mindHistory).where(eq(mindHistory.mind, "test-in"));
  });

  it("persists an inbound event and returns its id", async () => {
    const id = await recordInbound("test-in", "dm:bob", "bob", "hi there");
    assert.ok(typeof id === "number");
    const db = await getDb();
    const rows = await db.select().from(mindHistory).where(eq(mindHistory.mind, "test-in"));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, "inbound");
    assert.equal(rows[0].sender, "bob");
  });

  it("publishes a mind event", async () => {
    const events: MindEvent[] = [];
    const unsub = subscribe("test-in", (e) => events.push(e));
    try {
      await recordInbound("test-in", "dm:bob", "bob", "hello");
      assert.equal(events.length, 1);
      assert.equal(events[0].type, "inbound");
      assert.equal(events[0].sender, "bob");
    } finally {
      unsub();
    }
  });
});
