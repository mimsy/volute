import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type MindEvent, publish, subscribe } from "../src/lib/events/mind-events.js";

function event(type: string, content?: string): MindEvent {
  return { mind: "test", type, content };
}

describe("mind-events pub-sub", () => {
  it("subscribe + publish delivers event to subscriber", () => {
    const received: MindEvent[] = [];
    const unsub = subscribe("test", (e) => received.push(e));

    publish("test", event("text", "hello"));
    assert.equal(received.length, 1);
    assert.equal(received[0].content, "hello");

    unsub();
  });

  it("multiple subscribers receive the same event", () => {
    const received1: MindEvent[] = [];
    const received2: MindEvent[] = [];
    const unsub1 = subscribe("test", (e) => received1.push(e));
    const unsub2 = subscribe("test", (e) => received2.push(e));

    publish("test", event("text", "shared"));
    assert.equal(received1.length, 1);
    assert.equal(received2.length, 1);
    assert.equal(received1[0].content, "shared");
    assert.equal(received2[0].content, "shared");

    unsub1();
    unsub2();
  });

  it("unsubscribe stops delivery", () => {
    const received: MindEvent[] = [];
    const unsub = subscribe("test", (e) => received.push(e));

    publish("test", event("text", "first"));
    assert.equal(received.length, 1);

    unsub();

    publish("test", event("text", "second"));
    assert.equal(received.length, 1);
  });

  it("publishing to a mind with no subscribers is a no-op", () => {
    // Should not throw
    publish("nobody", event("text", "void"));
  });

  it("subscriber that throws is removed, others still receive", () => {
    const received: MindEvent[] = [];
    const badSub = subscribe("test", () => {
      throw new Error("boom");
    });
    const goodSub = subscribe("test", (e) => received.push(e));

    publish("test", event("text", "first"));
    // Good subscriber still received
    assert.equal(received.length, 1);

    // Bad subscriber was removed, so second publish only goes to good
    publish("test", event("text", "second"));
    assert.equal(received.length, 2);

    badSub();
    goodSub();
  });
});
