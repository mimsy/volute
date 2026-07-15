import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getOrCreateMindUser } from "../packages/daemon/src/lib/auth.js";
import { publish } from "../packages/daemon/src/lib/events/activity-events.js";
import { publishParticipantAdded } from "../packages/daemon/src/lib/events/conversation-events.js";
import {
  addMessage,
  addParticipant,
  createConversation,
} from "../packages/daemon/src/lib/events/conversations.js";
import {
  bufferEvent,
  getEventsSince,
  nextEventId,
  resetSequencer,
} from "../packages/daemon/src/lib/events/event-sequencer.js";
import eventsApp from "../packages/daemon/src/web/api/v1/events.js";
import { createSession } from "../packages/daemon/src/web/middleware/auth.js";

const NO_CONVS = new Set<string>();

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Open an in-process SSE connection to the events app and collect delivered
// events in the background until closed. Lets a test publish activity while the
// live subscription is active and observe exactly what gets delivered.
async function openEventStream(authHeader: string) {
  const res = await eventsApp.request("/", { headers: { Authorization: authHeader } });
  assert.equal(res.status, 200, "events stream should connect");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let active = true;
  const events: any[] = [];
  const loop = (async () => {
    try {
      while (active) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        for (;;) {
          const sep = buf.indexOf("\n\n");
          if (sep === -1) break;
          const frame = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          const json = dataLine.slice(dataLine.indexOf(":") + 1).trim();
          if (!json) continue;
          try {
            events.push(JSON.parse(json));
          } catch {}
        }
      }
    } catch {}
  })();
  return {
    events,
    async close() {
      active = false;
      try {
        await reader.cancel();
      } catch {}
      await loop;
    },
  };
}

describe("event sequencer", () => {
  it("assigns monotonically increasing IDs", () => {
    resetSequencer();
    const id1 = bufferEvent({
      event: "activity",
      id: 1,
      type: "mind_started",
      mind: "a",
      summary: "started",
      metadata: null,
      created_at: "2024-01-01",
    });
    const id2 = bufferEvent({
      event: "activity",
      id: 2,
      type: "mind_stopped",
      mind: "a",
      summary: "stopped",
      metadata: null,
      created_at: "2024-01-01",
    });
    assert.ok(id2 > id1);
  });

  it("replays events since a given ID", () => {
    resetSequencer();
    const id1 = bufferEvent({
      event: "activity",
      id: 1,
      type: "mind_started",
      mind: "a",
      summary: "s1",
      metadata: null,
      created_at: "2024-01-01",
    });
    const id2 = bufferEvent({
      event: "activity",
      id: 2,
      type: "mind_active",
      mind: "a",
      summary: "s2",
      metadata: null,
      created_at: "2024-01-01",
    });
    const id3 = bufferEvent({
      event: "activity",
      id: 3,
      type: "mind_idle",
      mind: "a",
      summary: "s3",
      metadata: null,
      created_at: "2024-01-01",
    });

    const events = getEventsSince(id1, NO_CONVS, undefined);
    assert.equal(events.length, 2);
    assert.equal(events[0].id, id2);
    assert.equal(events[1].id, id3);
  });

  it("returns empty array when no events after sinceId", () => {
    resetSequencer();
    const id = bufferEvent({
      event: "activity",
      id: 1,
      type: "mind_started",
      mind: "a",
      summary: "s",
      metadata: null,
      created_at: "2024-01-01",
    });

    const events = getEventsSince(id, NO_CONVS, undefined);
    assert.equal(events.length, 0);
  });

  it("returns empty array when sinceId is beyond all buffered", () => {
    resetSequencer();
    bufferEvent({
      event: "activity",
      id: 1,
      type: "mind_started",
      mind: "a",
      summary: "s",
      metadata: null,
      created_at: "2024-01-01",
    });

    const events = getEventsSince(9999, NO_CONVS, undefined);
    assert.equal(events.length, 0);
  });

  it("trims buffer when exceeding size limit", () => {
    resetSequencer();
    // Buffer 1005 events — should trim oldest 5
    for (let i = 0; i < 1005; i++) {
      bufferEvent({
        event: "activity",
        id: i,
        type: "mind_started",
        mind: "a",
        summary: `s${i}`,
        metadata: null,
        created_at: "2024-01-01",
      });
    }

    // Events with IDs 1-5 should have been trimmed
    // Trying to replay from 0 should only get ~1000 events
    const events = getEventsSince(0, NO_CONVS, undefined);
    assert.ok(events.length <= 1000);
    // First event should have ID > 5
    assert.ok(events[0].id > 5);
  });

  it("never replays snapshot events (they are connection-specific)", () => {
    resetSequencer();
    const id = bufferEvent({
      event: "snapshot",
      conversations: [],
      activity: [],
      activeMinds: [],
      onlineBrains: [],
    });
    assert.ok(id > 0);

    const events = getEventsSince(0, NO_CONVS, undefined);
    assert.equal(events.length, 0);
  });

  it("only replays conversation events to participants", () => {
    resetSequencer();
    bufferEvent({
      event: "conversation",
      conversationId: "conv-123",
      type: "message",
      id: 1,
      role: "user",
      senderName: "alice",
      content: [{ type: "text", text: "hello" }],
      createdAt: "2024-01-01",
    });

    // A caller who is not a participant sees nothing.
    assert.equal(getEventsSince(0, NO_CONVS, undefined).length, 0);
    assert.equal(getEventsSince(0, new Set(["other-conv"]), undefined).length, 0);

    // A participant sees the event.
    const events = getEventsSince(0, new Set(["conv-123"]), undefined);
    assert.equal(events.length, 1);
    assert.equal(events[0].data.event, "conversation");
  });

  it("filters conversation events but keeps global activity in a mixed buffer", () => {
    resetSequencer();
    bufferEvent({
      event: "activity",
      id: 1,
      type: "mind_started",
      mind: "a",
      summary: "s",
      metadata: null,
      created_at: "2024-01-01",
    });
    bufferEvent({
      event: "conversation",
      conversationId: "private-conv",
      type: "message",
      id: 2,
      role: "user",
      senderName: "bob",
      content: [{ type: "text", text: "secret" }],
      createdAt: "2024-01-01",
    });

    // Outsider gets only the global activity event, never the private message.
    const events = getEventsSince(0, NO_CONVS, undefined);
    assert.equal(events.length, 1);
    assert.equal(events[0].data.event, "activity");
  });

  it("gates activity events to the caller's own mind for non-privileged callers", () => {
    resetSequencer();
    bufferEvent({
      event: "activity",
      id: 1,
      type: "mind_done",
      mind: "mind-a",
      summary: "a did a thing",
      metadata: null,
      created_at: "2024-01-01",
    });
    bufferEvent({
      event: "activity",
      id: 2,
      type: "mind_done",
      mind: "mind-b",
      summary: "b did a thing",
      metadata: null,
      created_at: "2024-01-01",
    });

    // A non-privileged caller scoped to mind-a sees only mind-a's activity —
    // mind-b's turn summary must never be replayed cross-tenant.
    const scoped = getEventsSince(0, NO_CONVS, "mind-a");
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0].data.event, "activity");
    assert.equal(scoped[0].data.event === "activity" ? scoped[0].data.mind : null, "mind-a");

    // A privileged caller (undefined) sees the global feed.
    const global = getEventsSince(0, NO_CONVS, undefined);
    assert.equal(global.length, 2);
  });

  it("nextEventId advances the counter without buffering", () => {
    resetSequencer();
    const id = nextEventId();
    assert.ok(id > 0);
    // Nothing buffered, so no replay.
    assert.equal(getEventsSince(0, NO_CONVS, undefined).length, 0);
    // Subsequent buffered events get higher IDs.
    const bufId = bufferEvent({
      event: "activity",
      id: 1,
      type: "mind_started",
      mind: "a",
      summary: "s",
      metadata: null,
      created_at: "2024-01-01",
    });
    assert.ok(bufId > id);
  });
});

describe("v1 events live activity delivery filter", () => {
  it("does not deliver another mind's activity live to a scoped connection", async () => {
    resetSequencer();
    const alice = await getOrCreateMindUser("live-events-alice");
    const aliceSession = await createSession(alice.id);

    const stream = await openEventStream(`Bearer ${aliceSession}`);
    // Let the snapshot flush and the live subscription register.
    await delay(200);

    const before = nextEventId();
    await publish({ type: "mind_done", mind: "live-events-bob", summary: "bob-live-secret" });
    await publish({ type: "mind_done", mind: "live-events-alice", summary: "alice-live-visible" });
    await delay(200);
    await stream.close();

    const activityEvents = stream.events.filter((e) => e.event === "activity");

    // The scoped connection sees its own mind's activity live.
    assert.ok(
      activityEvents.some(
        (e) => e.mind === "live-events-alice" && e.summary === "alice-live-visible",
      ),
      "scoped connection should receive its own mind's activity live",
    );
    // But never another mind's activity — this is the live audience gate under test.
    assert.ok(
      !activityEvents.some((e) => e.mind === "live-events-bob"),
      "scoped connection must not receive another mind's activity live",
    );

    // Buffer coverage: the other mind's event is still recorded globally, so a
    // privileged reconnect replay (getEventsSince) can deliver it. This is the
    // regression the buffer-before-gate ordering protects against.
    const replay = getEventsSince(before, NO_CONVS, undefined);
    assert.ok(
      replay.some((e) => e.data.event === "activity" && e.data.mind === "live-events-bob"),
      "buffer must still record another mind's activity globally for reconnect replay",
    );
  });

  it("delivers any mind's activity live to a privileged connection", async () => {
    resetSequencer();
    const prevToken = process.env.VOLUTE_DAEMON_TOKEN;
    process.env.VOLUTE_DAEMON_TOKEN = "live-events-admin-token";
    try {
      const stream = await openEventStream("Bearer live-events-admin-token");
      await delay(200);
      await publish({ type: "mind_done", mind: "live-events-charlie", summary: "charlie-live" });
      await delay(200);
      await stream.close();

      const activityEvents = stream.events.filter((e) => e.event === "activity");
      assert.ok(
        activityEvents.some((e) => e.mind === "live-events-charlie"),
        "privileged connection should receive any mind's activity live",
      );
    } finally {
      if (prevToken === undefined) delete process.env.VOLUTE_DAEMON_TOKEN;
      else process.env.VOLUTE_DAEMON_TOKEN = prevToken;
    }
  });
});

describe("v1 events replay ring buffers each event once", () => {
  it("stores a single copy even with two subscribed clients", async () => {
    resetSequencer();
    const prevToken = process.env.VOLUTE_DAEMON_TOKEN;
    process.env.VOLUTE_DAEMON_TOKEN = "ring-once-admin-token";
    try {
      const s1 = await openEventStream("Bearer ring-once-admin-token");
      const s2 = await openEventStream("Bearer ring-once-admin-token");
      await delay(200);

      const before = nextEventId();
      await publish({ type: "mind_done", mind: "ring-once-mind", summary: "ring-once-summary" });
      await delay(200);
      await s1.close();
      await s2.close();

      // Both clients still receive it live, each exactly once.
      for (const s of [s1, s2]) {
        const hits = s.events.filter(
          (e) => e.event === "activity" && e.summary === "ring-once-summary",
        );
        assert.equal(hits.length, 1, "each client sees the event once live");
      }

      // But the global replay ring holds exactly one copy, not one per connected
      // client — the regression this fix guards against. Reconnect replay still works.
      const replay = getEventsSince(before, NO_CONVS, undefined);
      const copies = replay.filter(
        (e) => e.data.event === "activity" && e.data.summary === "ring-once-summary",
      );
      assert.equal(copies.length, 1, "event buffered exactly once globally");
    } finally {
      if (prevToken === undefined) delete process.env.VOLUTE_DAEMON_TOKEN;
      else process.env.VOLUTE_DAEMON_TOKEN = prevToken;
    }
  });
});

describe("v1 events live delivery of newly created conversations", () => {
  it("delivers a conversation_added event and its messages without reconnecting", async () => {
    resetSequencer();
    // Alice is already watching the dashboard (connected before the conversation
    // exists). Bob will start a brand-new DM with her — the seed-message scenario.
    const alice = await getOrCreateMindUser("new-conv-alice");
    const bob = await getOrCreateMindUser("new-conv-bob");
    const aliceSession = await createSession(alice.id);

    const stream = await openEventStream(`Bearer ${aliceSession}`);
    // Let the snapshot flush and the live subscriptions register.
    await delay(200);

    // A conversation that did not exist at connect time, with its first message
    // sent immediately after — the realistic seed-first-DM flow, no artificial
    // gap. The daemon must announce the conversation before forwarding messages.
    const conv = await createConversation({
      userId: bob.id,
      participantIds: [bob.id, alice.id],
      type: "dm",
    });
    await addMessage(conv.id, "user", "new-conv-bob", [
      { type: "text", text: "hello from a brand-new dm" },
    ]);
    await delay(200);
    await stream.close();

    // The new conversation is pushed live so it appears in the list without reload.
    const added = stream.events.filter(
      (e) => e.event === "conversation_added" && e.conversation?.id === conv.id,
    );
    assert.equal(added.length, 1, "should receive exactly one conversation_added for the new DM");
    assert.ok(
      added[0].conversation.participants?.some((p: any) => p.username === "new-conv-alice"),
      "conversation_added should carry enriched participants",
    );

    // And messages to that new conversation flow live thereafter.
    const messages = stream.events.filter(
      (e) => e.event === "conversation" && e.conversationId === conv.id && e.type === "message",
    );
    assert.ok(
      messages.some((m) =>
        m.content?.some((b: any) => b.type === "text" && b.text.includes("brand-new dm")),
      ),
      "the new conversation's first message should be delivered live",
    );

    // conversation_added must arrive before the first message: the client drops
    // messages for conversations it doesn't yet know about, so out-of-order
    // delivery would lose the first message's preview/unread until reload.
    const order = stream.events
      .filter(
        (e) =>
          (e.event === "conversation_added" && e.conversation?.id === conv.id) ||
          (e.event === "conversation" && e.conversationId === conv.id),
      )
      .map((e) => e.event);
    assert.equal(order[0], "conversation_added", "conversation_added must precede its messages");
  });

  it("delivers conversation_added when added to an existing conversation live", async () => {
    resetSequencer();
    // Carl is watching. A group exists between Dana and Erin that already has a
    // message; Carl is then added to it — the "added to an existing channel" path.
    const carl = await getOrCreateMindUser("add-part-carl");
    const dana = await getOrCreateMindUser("add-part-dana");
    const erin = await getOrCreateMindUser("add-part-erin");
    const carlSession = await createSession(carl.id);

    const conv = await createConversation({
      userId: dana.id,
      participantIds: [dana.id, erin.id],
      type: "channel",
    });
    await addMessage(conv.id, "user", "add-part-dana", [{ type: "text", text: "pre-existing" }]);

    const stream = await openEventStream(`Bearer ${carlSession}`);
    await delay(200);
    // Carl isn't a participant yet — nothing for this conversation so far.
    assert.ok(
      !stream.events.some(
        (e) => e.event === "conversation_added" && e.conversation?.id === conv.id,
      ),
      "no conversation_added before being added",
    );

    await addParticipant(conv.id, carl.id);
    await delay(200);
    await stream.close();

    const added = stream.events.filter(
      (e) => e.event === "conversation_added" && e.conversation?.id === conv.id,
    );
    assert.equal(added.length, 1, "added participant receives one conversation_added");
    // The enriched payload carries the pre-existing last message.
    assert.equal(
      added[0].conversation.lastMessage?.text,
      "pre-existing",
      "conversation_added carries the existing last-message preview",
    );
  });

  it("does not re-announce or double-subscribe an already-known conversation", async () => {
    resetSequencer();
    const fay = await getOrCreateMindUser("dedup-fay");
    const gil = await getOrCreateMindUser("dedup-gil");
    const faySession = await createSession(fay.id);

    const stream = await openEventStream(`Bearer ${faySession}`);
    await delay(200);

    const conv = await createConversation({
      userId: gil.id,
      participantIds: [gil.id, fay.id],
      type: "dm",
    });
    await delay(150);
    // A duplicate participant-added for the same (conversation, user) — must be
    // ignored, or messages would be forwarded twice to the UI.
    publishParticipantAdded(conv.id, fay.id);
    await delay(50);
    await addMessage(conv.id, "user", "dedup-gil", [{ type: "text", text: "once" }]);
    await delay(200);
    await stream.close();

    const added = stream.events.filter(
      (e) => e.event === "conversation_added" && e.conversation?.id === conv.id,
    );
    assert.equal(added.length, 1, "conversation_added emitted exactly once");
    const messages = stream.events.filter(
      (e) => e.event === "conversation" && e.conversationId === conv.id && e.type === "message",
    );
    assert.equal(messages.length, 1, "message delivered exactly once (no double subscription)");
  });

  it("does not leak new conversations to non-participants", async () => {
    resetSequencer();
    const viewer = await getOrCreateMindUser("new-conv-viewer");
    const sender = await getOrCreateMindUser("new-conv-sender");
    const other = await getOrCreateMindUser("new-conv-other");
    const viewerSession = await createSession(viewer.id);

    const stream = await openEventStream(`Bearer ${viewerSession}`);
    await delay(200);

    // A DM between two other users the viewer is not part of.
    const conv = await createConversation({
      userId: sender.id,
      participantIds: [sender.id, other.id],
      type: "dm",
    });
    await delay(100);
    await addMessage(conv.id, "user", "new-conv-sender", [{ type: "text", text: "private" }]);
    await delay(200);
    await stream.close();

    assert.ok(
      !stream.events.some(
        (e) => e.event === "conversation_added" && e.conversation?.id === conv.id,
      ),
      "viewer must not receive conversation_added for a conversation they are not in",
    );
    assert.ok(
      !stream.events.some((e) => e.event === "conversation" && e.conversationId === conv.id),
      "viewer must not receive messages for a conversation they are not in",
    );
  });
});
