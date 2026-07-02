import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bufferEvent,
  getEventsSince,
  nextEventId,
  resetSequencer,
} from "../packages/daemon/src/lib/events/event-sequencer.js";

const NO_CONVS = new Set<string>();

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

    const events = getEventsSince(id1, NO_CONVS);
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

    const events = getEventsSince(id, NO_CONVS);
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

    const events = getEventsSince(9999, NO_CONVS);
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
    const events = getEventsSince(0, NO_CONVS);
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

    const events = getEventsSince(0, NO_CONVS);
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
    assert.equal(getEventsSince(0, NO_CONVS).length, 0);
    assert.equal(getEventsSince(0, new Set(["other-conv"])).length, 0);

    // A participant sees the event.
    const events = getEventsSince(0, new Set(["conv-123"]));
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
    const events = getEventsSince(0, NO_CONVS);
    assert.equal(events.length, 1);
    assert.equal(events[0].data.event, "activity");
  });

  it("nextEventId advances the counter without buffering", () => {
    resetSequencer();
    const id = nextEventId();
    assert.ok(id > 0);
    // Nothing buffered, so no replay.
    assert.equal(getEventsSince(0, NO_CONVS).length, 0);
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
