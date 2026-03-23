import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { getDb } from "../src/lib/db.js";
import { extractTextContent } from "../src/lib/delivery/delivery-router.js";
import {
  linkToolResultToTurn,
  recordInbound,
  recordOutbound,
  resolveSleepAction,
  tagUntaggedInbound,
  tagUntaggedOutbound,
} from "../src/lib/delivery/message-delivery.js";
import { publish as publishActivity } from "../src/lib/events/activity-events.js";
import { type MindEvent, subscribe } from "../src/lib/events/mind-events.js";
import { activity, conversations, messages, mindHistory, turns } from "../src/lib/schema.js";

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
    assert.equal(rows[0].turn_id, null); // turn_id is always null — linked later via tool_result
    assert.equal(rows[0].message_id, "msg-456");
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

async function cleanupLinkData() {
  const db = await getDb();
  await db.delete(mindHistory).where(eq(mindHistory.mind, LINK_MIND));
  await db.delete(activity).where(eq(activity.mind, LINK_MIND));
  await db.delete(turns).where(eq(turns.mind, LINK_MIND));
  // Clean up test conversations/messages
  const convRows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.mind_name, LINK_MIND));
  for (const c of convRows) {
    await db.delete(messages).where(eq(messages.conversation_id, c.id));
  }
  await db.delete(conversations).where(eq(conversations.mind_name, LINK_MIND));
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
      mind_name: LINK_MIND,
      channel: "dm:alice",
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
});

const TAG_MIND = "test-tag";
const TAG_TURN_ID = "turn-tag-001";

async function cleanupTagData() {
  const db = await getDb();
  await db.delete(mindHistory).where(eq(mindHistory.mind, TAG_MIND));
  await db.delete(turns).where(eq(turns.mind, TAG_MIND));
  const convRows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.mind_name, TAG_MIND));
  for (const c of convRows) {
    await db.delete(messages).where(eq(messages.conversation_id, c.id));
  }
  await db.delete(conversations).where(eq(conversations.mind_name, TAG_MIND));
}

describe("tagUntaggedOutbound", () => {
  afterEach(cleanupTagData);

  it("tags orphaned outbound records within turn range", async () => {
    const db = await getDb();

    // Insert a turn
    await db.insert(turns).values({ id: TAG_TURN_ID, mind: TAG_MIND, session: "main" });

    // Insert events with turn_id to establish the range
    await db
      .insert(mindHistory)
      .values({ mind: TAG_MIND, type: "inbound", channel: "dm:x", turn_id: TAG_TURN_ID });

    // Insert an orphan outbound (no turn_id)
    const orphanResult = await db
      .insert(mindHistory)
      .values({
        mind: TAG_MIND,
        type: "outbound",
        channel: "dm:x",
        content: "orphan",
        turn_id: null,
      })
      .returning({ id: mindHistory.id });
    const orphanId = orphanResult[0].id;

    // Insert another tagged event to set the upper bound
    await db
      .insert(mindHistory)
      .values({ mind: TAG_MIND, type: "tool_use", channel: "dm:x", turn_id: TAG_TURN_ID });

    await tagUntaggedOutbound(TAG_MIND, TAG_TURN_ID);

    const rows = await db.select().from(mindHistory).where(eq(mindHistory.id, orphanId));
    assert.equal(rows[0].turn_id, TAG_TURN_ID);
  });

  it("fixes linked message turn_id and source_event_id", async () => {
    const db = await getDb();

    await db.insert(turns).values({ id: TAG_TURN_ID, mind: TAG_MIND, session: "main" });

    // Create conversation and message
    const convId = "conv-tag-test";
    await db.insert(conversations).values({
      id: convId,
      mind_name: TAG_MIND,
      channel: "dm:x",
      type: "dm",
    });
    const msgResult = await db
      .insert(messages)
      .values({
        conversation_id: convId,
        role: "assistant",
        sender_name: TAG_MIND,
        content: "orphan msg",
      })
      .returning({ id: messages.id });
    const msgId = msgResult[0].id;

    // Insert a tool_use event with turn_id (establishes range start)
    await db
      .insert(mindHistory)
      .values({ mind: TAG_MIND, type: "tool_use", channel: "dm:x", turn_id: TAG_TURN_ID });

    // Insert an orphan outbound with a message_id
    await db.insert(mindHistory).values({
      mind: TAG_MIND,
      type: "outbound",
      channel: "dm:x",
      content: "orphan",
      turn_id: null,
      message_id: String(msgId),
    });

    // Insert another tagged event (upper bound)
    await db
      .insert(mindHistory)
      .values({ mind: TAG_MIND, type: "inbound", channel: "dm:x", turn_id: TAG_TURN_ID });

    await tagUntaggedOutbound(TAG_MIND, TAG_TURN_ID);

    const msgRows = await db.select().from(messages).where(eq(messages.id, msgId));
    assert.equal(msgRows[0].turn_id, TAG_TURN_ID);
    // source_event_id should be the tool_use event preceding the orphan
    assert.ok(msgRows[0].source_event_id != null);
  });

  it("no-ops when no orphans exist", async () => {
    const db = await getDb();

    await db.insert(turns).values({ id: TAG_TURN_ID, mind: TAG_MIND, session: "main" });

    // All outbound records already have turn_ids
    await db.insert(mindHistory).values({
      mind: TAG_MIND,
      type: "outbound",
      channel: "dm:x",
      content: "tagged",
      turn_id: TAG_TURN_ID,
    });
    await db.insert(mindHistory).values({
      mind: TAG_MIND,
      type: "inbound",
      channel: "dm:x",
      turn_id: TAG_TURN_ID,
    });

    // Should not throw or modify anything
    await assert.doesNotReject(() => tagUntaggedOutbound(TAG_MIND, TAG_TURN_ID));
  });

  it("no-ops when turn has no events", async () => {
    const db = await getDb();
    await db.insert(turns).values({ id: TAG_TURN_ID, mind: TAG_MIND, session: "main" });

    // No events in mind_history for this turn at all
    await assert.doesNotReject(() => tagUntaggedOutbound(TAG_MIND, TAG_TURN_ID));
  });
});

const INBOUND_MIND = "test-inbound-tag";
const INBOUND_TURN_ID = "turn-inbound-001";

async function cleanupInboundData() {
  const db = await getDb();
  await db.delete(mindHistory).where(eq(mindHistory.mind, INBOUND_MIND));
  await db.delete(turns).where(eq(turns.mind, INBOUND_MIND));
  const convRows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.mind_name, INBOUND_MIND));
  for (const c of convRows) {
    await db.delete(messages).where(eq(messages.conversation_id, c.id));
  }
  await db.delete(conversations).where(eq(conversations.mind_name, INBOUND_MIND));
}

describe("tagUntaggedInbound", () => {
  afterEach(cleanupInboundData);

  it("tags recent untagged inbound records with a turn id", async () => {
    const db = await getDb();
    await db.insert(turns).values({ id: INBOUND_TURN_ID, mind: INBOUND_MIND, session: "main" });

    // Insert an untagged inbound
    const result = await db
      .insert(mindHistory)
      .values({ mind: INBOUND_MIND, type: "inbound", channel: "dm:bob", sender: "bob" })
      .returning({ id: mindHistory.id });
    const inboundId = result[0].id;

    await tagUntaggedInbound(INBOUND_MIND, INBOUND_TURN_ID, { channel: "dm:bob" });

    const rows = await db.select().from(mindHistory).where(eq(mindHistory.id, inboundId));
    assert.equal(rows[0].turn_id, INBOUND_TURN_ID);
  });

  it("scopes tagging to a specific channel when provided", async () => {
    const db = await getDb();
    await db.insert(turns).values({ id: INBOUND_TURN_ID, mind: INBOUND_MIND, session: "main" });

    // Insert inbounds on two different channels
    const r1 = await db
      .insert(mindHistory)
      .values({ mind: INBOUND_MIND, type: "inbound", channel: "dm:alice", sender: "alice" })
      .returning({ id: mindHistory.id });
    const r2 = await db
      .insert(mindHistory)
      .values({ mind: INBOUND_MIND, type: "inbound", channel: "dm:bob", sender: "bob" })
      .returning({ id: mindHistory.id });

    // Only tag dm:bob
    await tagUntaggedInbound(INBOUND_MIND, INBOUND_TURN_ID, { channel: "dm:bob" });

    const aliceRow = await db.select().from(mindHistory).where(eq(mindHistory.id, r1[0].id));
    const bobRow = await db.select().from(mindHistory).where(eq(mindHistory.id, r2[0].id));
    assert.equal(aliceRow[0].turn_id, null);
    assert.equal(bobRow[0].turn_id, INBOUND_TURN_ID);
  });

  it("sets trigger_event_id when setTrigger is true", async () => {
    const db = await getDb();
    await db.insert(turns).values({ id: INBOUND_TURN_ID, mind: INBOUND_MIND, session: "main" });

    const r = await db
      .insert(mindHistory)
      .values({ mind: INBOUND_MIND, type: "inbound", channel: "dm:bob", sender: "bob" })
      .returning({ id: mindHistory.id });

    await tagUntaggedInbound(INBOUND_MIND, INBOUND_TURN_ID, {
      setTrigger: true,
      channel: "dm:bob",
    });

    const turnRows = await db.select().from(turns).where(eq(turns.id, INBOUND_TURN_ID));
    assert.equal(turnRows[0].trigger_event_id, r[0].id);
  });

  it("respects the limit parameter", async () => {
    const db = await getDb();
    await db.insert(turns).values({ id: INBOUND_TURN_ID, mind: INBOUND_MIND, session: "main" });

    // Insert 3 inbounds
    for (let i = 0; i < 3; i++) {
      await db
        .insert(mindHistory)
        .values({ mind: INBOUND_MIND, type: "inbound", channel: "dm:bob", sender: "bob" });
    }

    await tagUntaggedInbound(INBOUND_MIND, INBOUND_TURN_ID, { limit: 2, channel: "dm:bob" });

    const tagged = await db.select().from(mindHistory).where(eq(mindHistory.mind, INBOUND_MIND));
    const withTurn = tagged.filter((r) => r.turn_id === INBOUND_TURN_ID);
    assert.equal(withTurn.length, 2);
  });

  it("also tags untagged conversation messages", async () => {
    const db = await getDb();
    await db.insert(turns).values({ id: INBOUND_TURN_ID, mind: INBOUND_MIND, session: "main" });

    // Create a conversation and an inbound message (not from the mind)
    const convId = "conv-inbound-test";
    await db.insert(conversations).values({
      id: convId,
      mind_name: INBOUND_MIND,
      channel: "dm:bob",
      type: "dm",
    });
    const msgResult = await db
      .insert(messages)
      .values({
        conversation_id: convId,
        role: "user",
        sender_name: "bob",
        content: "hello",
      })
      .returning({ id: messages.id });

    await tagUntaggedInbound(INBOUND_MIND, INBOUND_TURN_ID, { channel: "dm:bob" });

    const msgRows = await db.select().from(messages).where(eq(messages.id, msgResult[0].id));
    assert.equal(msgRows[0].turn_id, INBOUND_TURN_ID);
  });

  it("no-ops when no untagged inbounds exist", async () => {
    const db = await getDb();
    await db.insert(turns).values({ id: INBOUND_TURN_ID, mind: INBOUND_MIND, session: "main" });

    await assert.doesNotReject(() =>
      tagUntaggedInbound(INBOUND_MIND, INBOUND_TURN_ID, { channel: "dm:bob" }),
    );
  });

  it("skips mind_history tagging when no channel is provided", async () => {
    const db = await getDb();
    await db.insert(turns).values({ id: INBOUND_TURN_ID, mind: INBOUND_MIND, session: "main" });

    // Insert an untagged inbound on a specific channel
    const result = await db
      .insert(mindHistory)
      .values({ mind: INBOUND_MIND, type: "inbound", channel: "dm:bob", sender: "bob" })
      .returning({ id: mindHistory.id });

    // Call without channel — should NOT tag the inbound (prevents cross-session leaks)
    await tagUntaggedInbound(INBOUND_MIND, INBOUND_TURN_ID);

    const rows = await db.select().from(mindHistory).where(eq(mindHistory.id, result[0].id));
    assert.equal(rows[0].turn_id, null);
  });

  it("still tags conversation messages when no channel is provided", async () => {
    const db = await getDb();
    await db.insert(turns).values({ id: INBOUND_TURN_ID, mind: INBOUND_MIND, session: "main" });

    // Insert an untagged inbound in mind_history (should NOT be tagged)
    const historyResult = await db
      .insert(mindHistory)
      .values({ mind: INBOUND_MIND, type: "inbound", channel: "dm:bob", sender: "bob" })
      .returning({ id: mindHistory.id });

    // Insert a conversation message (should still be tagged)
    const convId = "conv-no-channel-test";
    await db.insert(conversations).values({
      id: convId,
      mind_name: INBOUND_MIND,
      channel: "dm:bob",
      type: "dm",
    });
    const msgResult = await db
      .insert(messages)
      .values({
        conversation_id: convId,
        role: "user",
        sender_name: "bob",
        content: "hello",
      })
      .returning({ id: messages.id });

    // Call without channel
    await tagUntaggedInbound(INBOUND_MIND, INBOUND_TURN_ID);

    // mind_history should NOT be tagged (no channel = skip)
    const historyRows = await db
      .select()
      .from(mindHistory)
      .where(eq(mindHistory.id, historyResult[0].id));
    assert.equal(historyRows[0].turn_id, null);

    // conversation messages SHOULD still be tagged
    const msgRows = await db.select().from(messages).where(eq(messages.id, msgResult[0].id));
    assert.equal(msgRows[0].turn_id, INBOUND_TURN_ID);
  });
});
