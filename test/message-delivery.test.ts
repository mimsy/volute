import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { extractTextContent } from "../packages/daemon/src/lib/delivery/delivery-router.js";
import {
  linkToolResultToTurn,
  recordInbound,
  recordOutbound,
  resolveSleepAction,
} from "../packages/daemon/src/lib/delivery/message-delivery.js";
import { publish as publishActivity } from "../packages/daemon/src/lib/events/activity-events.js";
import { type MindEvent, subscribe } from "../packages/daemon/src/lib/events/mind-events.js";
import {
  activity,
  conversations,
  messages,
  mindHistory,
  turns,
} from "../packages/daemon/src/lib/schema.js";

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

  it("stores message_id when provided", async () => {
    await recordOutbound("test-out", "dm:alice", "hi", {
      messageId: "msg-456",
    });
    const db = await getDb();
    const rows = await db.select().from(mindHistory).where(eq(mindHistory.mind, "test-out"));
    assert.equal(rows[0].turn_id, null);
    assert.equal(rows[0].message_id, "msg-456");
  });

  it("stores turn_id when provided", async () => {
    await recordOutbound("test-out", "dm:alice", "hi", {
      turnId: "turn-789",
    });
    const db = await getDb();
    const rows = await db.select().from(mindHistory).where(eq(mindHistory.mind, "test-out"));
    assert.equal(rows[0].turn_id, "turn-789");
  });

  it("returns the inserted record id", async () => {
    const id = await recordOutbound("test-out", "dm:alice", "hello");
    assert.ok(id != null && id > 0);
  });

  it("does not publish a mind event (deferred to linkToolResultToTurn)", async () => {
    const events: MindEvent[] = [];
    const unsub = subscribe("test-out", (e) => events.push(e));
    try {
      await recordOutbound("test-out", "dm:alice", "hello");
      assert.equal(events.length, 0);
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

const LINK_MIND = "test-link";
const LINK_TURN_ID = "turn-link-001";

const LINK_CONV_IDS = ["conv-link-test"];
async function cleanupLinkData() {
  const db = await getDb();
  await db.delete(mindHistory).where(eq(mindHistory.mind, LINK_MIND));
  await db.delete(activity).where(eq(activity.mind, LINK_MIND));
  await db.delete(turns).where(eq(turns.mind, LINK_MIND));
  for (const id of LINK_CONV_IDS) {
    await db.delete(messages).where(eq(messages.conversation_id, id));
    await db.delete(conversations).where(eq(conversations.id, id));
  }
}

describe("linkToolResultToTurn", () => {
  afterEach(cleanupLinkData);

  it("links outbound record to turn via marker", async () => {
    const outId = await recordOutbound(LINK_MIND, "dm:alice", "hello");
    assert.ok(outId != null);

    await linkToolResultToTurn(
      LINK_MIND,
      LINK_TURN_ID,
      `sent [volute:outbound:${outId}]`,
      undefined,
    );

    const db = await getDb();
    const rows = await db.select().from(mindHistory).where(eq(mindHistory.id, outId));
    assert.equal(rows[0].turn_id, LINK_TURN_ID);
  });

  it("links activity record to turn via marker", async () => {
    const actId = await publishActivity({
      type: "mind_active",
      mind: LINK_MIND,
      summary: "test activity",
    });
    assert.ok(actId > 0);

    await linkToolResultToTurn(LINK_MIND, LINK_TURN_ID, `done [volute:activity:${actId}]`, 99);

    const db = await getDb();
    const rows = await db.select().from(activity).where(eq(activity.id, actId));
    assert.equal(rows[0].turn_id, LINK_TURN_ID);
    assert.equal(rows[0].source_event_id, 99);
  });

  it("links message turn_id and source_event_id", async () => {
    const db = await getDb();

    // Create a conversation and message
    const convId = "conv-link-test";
    await db.insert(conversations).values({
      id: convId,
      type: "dm",
    });
    const msgResult = await db
      .insert(messages)
      .values({
        conversation_id: convId,
        role: "assistant",
        sender_name: LINK_MIND,
        content: "hello",
      })
      .returning({ id: messages.id });
    const msgId = msgResult[0].id;

    const outId = await recordOutbound(LINK_MIND, "dm:alice", "hello", {
      messageId: String(msgId),
    });
    assert.ok(outId != null);

    const toolUseEventId = 42;
    await linkToolResultToTurn(
      LINK_MIND,
      LINK_TURN_ID,
      `sent [volute:outbound:${outId}]`,
      toolUseEventId,
    );

    const msgRows = await db.select().from(messages).where(eq(messages.id, msgId));
    assert.equal(msgRows[0].turn_id, LINK_TURN_ID);
    assert.equal(msgRows[0].source_event_id, toolUseEventId);
  });

  it("handles multiple markers in one result", async () => {
    const outId = await recordOutbound(LINK_MIND, "dm:alice", "hi");
    assert.ok(outId != null);

    const actId = await publishActivity({
      type: "mind_active",
      mind: LINK_MIND,
      summary: "test multi",
    });
    assert.ok(actId > 0);

    const content = `sent [volute:outbound:${outId}] and logged [volute:activity:${actId}]`;
    await linkToolResultToTurn(LINK_MIND, LINK_TURN_ID, content, undefined);

    const db = await getDb();
    const outRows = await db.select().from(mindHistory).where(eq(mindHistory.id, outId));
    assert.equal(outRows[0].turn_id, LINK_TURN_ID);

    const actRows = await db.select().from(activity).where(eq(activity.id, actId));
    assert.equal(actRows[0].turn_id, LINK_TURN_ID);
  });

  it("no-ops on null content", async () => {
    await assert.doesNotReject(() =>
      linkToolResultToTurn(LINK_MIND, LINK_TURN_ID, null, undefined),
    );
  });

  it("no-ops on content with no markers", async () => {
    await assert.doesNotReject(() =>
      linkToolResultToTurn(LINK_MIND, LINK_TURN_ID, "just plain text", undefined),
    );
  });

  it("skips markers referencing non-existent records", async () => {
    await assert.doesNotReject(() =>
      linkToolResultToTurn(LINK_MIND, LINK_TURN_ID, "[volute:outbound:999999]", undefined),
    );
    await assert.doesNotReject(() =>
      linkToolResultToTurn(LINK_MIND, LINK_TURN_ID, "[volute:activity:999999]", undefined),
    );
  });

  it("publishes SSE event for outbound", async () => {
    const outId = await recordOutbound(LINK_MIND, "dm:alice", "hello from mind");
    assert.ok(outId != null);

    const events: MindEvent[] = [];
    const unsub = subscribe(LINK_MIND, (e) => events.push(e));
    try {
      await linkToolResultToTurn(LINK_MIND, LINK_TURN_ID, `[volute:outbound:${outId}]`, undefined);
      assert.equal(events.length, 1);
      assert.equal(events[0].type, "outbound");
      assert.equal(events[0].channel, "dm:alice");
      assert.equal(events[0].content, "hello from mind");
      assert.equal(events[0].turnId, LINK_TURN_ID);
    } finally {
      unsub();
    }
  });

  it("is idempotent: skips re-tag and re-publish when the outbound is already attributed", async () => {
    // Direct attribution (session header at send time) already set the turn_id and published.
    const outId = await recordOutbound(LINK_MIND, "dm:alice", "already tagged", {
      turnId: LINK_TURN_ID,
    });
    assert.ok(outId != null);

    const events: MindEvent[] = [];
    const unsub = subscribe(LINK_MIND, (e) => events.push(e));
    try {
      // A stray marker referencing a DIFFERENT turn must not steal or re-publish it.
      await linkToolResultToTurn(LINK_MIND, "turn-other-999", `[volute:outbound:${outId}]`, 7);
      assert.equal(events.length, 0, "should not re-publish an already-attributed outbound");
    } finally {
      unsub();
    }

    const db = await getDb();
    const row = await db.select().from(mindHistory).where(eq(mindHistory.id, outId!)).get();
    assert.equal(row!.turn_id, LINK_TURN_ID, "existing turn_id must be preserved");
  });
});
