import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type ActivityEvent, publish, subscribe } from "../src/lib/events/activity-events.js";

function makeEvent(overrides?: Partial<ActivityEvent>): ActivityEvent {
  return {
    type: "mind_started",
    mind: "test-mind",
    summary: "test-mind started",
    ...overrides,
  };
}

describe("activity-events", () => {
  it("subscribe + publish delivers event to callback", async () => {
    const received: any[] = [];
    const unsub = subscribe((e) => received.push(e));
    await publish(makeEvent());
    assert.equal(received.length, 1);
    assert.equal(received[0].type, "mind_started");
    assert.equal(received[0].mind, "test-mind");
    assert.equal(received[0].summary, "test-mind started");
    assert.ok(received[0].created_at);
    unsub();
  });

  it("unsubscribe stops delivery", async () => {
    const received: any[] = [];
    const unsub = subscribe((e) => received.push(e));
    await publish(makeEvent());
    assert.equal(received.length, 1);
    unsub();
    await publish(makeEvent());
    assert.equal(received.length, 1);
  });

  it("multiple subscribers all receive event", async () => {
    const received1: any[] = [];
    const received2: any[] = [];
    const unsub1 = subscribe((e) => received1.push(e));
    const unsub2 = subscribe((e) => received2.push(e));
    await publish(makeEvent());
    assert.equal(received1.length, 1);
    assert.equal(received2.length, 1);
    unsub1();
    unsub2();
  });

  it("throwing subscriber is removed and doesn't block others", async () => {
    const received: any[] = [];
    const unsub1 = subscribe(() => {
      throw new Error("boom");
    });
    const unsub2 = subscribe((e) => received.push(e));
    await publish(makeEvent());
    assert.equal(received.length, 1);
    unsub1();
    unsub2();
  });

  it("passes metadata through", async () => {
    const received: any[] = [];
    const unsub = subscribe((e) => received.push(e));
    await publish(makeEvent({ type: "page_updated", metadata: { file: "blog.html" } }));
    assert.equal(received[0].type, "page_updated");
    assert.deepEqual(received[0].metadata, { file: "blog.html" });
    unsub();
  });

  it("publish with no subscribers is a no-op", async () => {
    // Should not throw
    await publish(makeEvent());
  });
});
