import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getOrCreateMindUser } from "../packages/daemon/src/lib/auth.js";
import { publish } from "../packages/daemon/src/lib/events/activity-events.js";
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
