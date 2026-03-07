import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type ConversationEvent,
  publish,
  subscribe,
} from "../src/lib/events/conversation-events.js";

function makeEvent(
  overrides?: Partial<ConversationEvent & { type: "message" }>,
): ConversationEvent {
  return {
    type: "message",
    id: 1,
    role: "user",
    senderName: "alice",
    content: [{ type: "text", text: "hello" }],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("conversation-events", () => {
  it("subscribe + publish delivers event to callback", () => {
    const received: ConversationEvent[] = [];
    const unsub = subscribe("conv-1", (e) => received.push(e));
    const event = makeEvent();
    publish("conv-1", event);
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], event);
    unsub();
  });

  it("unsubscribe stops delivery", () => {
    const received: ConversationEvent[] = [];
    const unsub = subscribe("conv-2", (e) => received.push(e));
    publish("conv-2", makeEvent());
    assert.equal(received.length, 1);
    unsub();
    publish("conv-2", makeEvent());
    assert.equal(received.length, 1);
  });

  it("unsubscribe cleans up empty Set", () => {
    const unsub = subscribe("conv-3", () => {});
    unsub();
    // Publishing to a cleaned-up conversation should be a no-op (no throw)
    publish("conv-3", makeEvent());
  });

  it("multiple subscribers all receive event", () => {
    const received1: ConversationEvent[] = [];
    const received2: ConversationEvent[] = [];
    const unsub1 = subscribe("conv-4", (e) => received1.push(e));
    const unsub2 = subscribe("conv-4", (e) => received2.push(e));
    const event = makeEvent();
    publish("conv-4", event);
    assert.equal(received1.length, 1);
    assert.equal(received2.length, 1);
    assert.deepEqual(received1[0], event);
    assert.deepEqual(received2[0], event);
    unsub1();
    unsub2();
  });

  it("publish to unknown conversation is a no-op", () => {
    // Should not throw
    publish("conv-nonexistent", makeEvent());
  });

  it("throwing subscriber is removed and doesn't block others", () => {
    const received: ConversationEvent[] = [];
    const unsub1 = subscribe("conv-5", () => {
      throw new Error("boom");
    });
    const unsub2 = subscribe("conv-5", (e) => received.push(e));

    publish("conv-5", makeEvent());

    // The non-throwing subscriber should still receive the event
    assert.equal(received.length, 1);
    unsub1();
    unsub2();
  });

  it("remaining subscribers still receive events after one is removed", () => {
    const received: ConversationEvent[] = [];
    const unsub1 = subscribe("conv-6", () => {});
    const unsub2 = subscribe("conv-6", (e) => received.push(e));
    unsub1();
    publish("conv-6", makeEvent());
    assert.equal(received.length, 1);
    unsub2();
  });
});
