import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";
import { type ActivityEvent, subscribe } from "../src/lib/activity-events.js";
import { getDb } from "../src/lib/db.js";
import { markIdle, onMindEvent, stopAll } from "../src/lib/mind-activity-tracker.js";

// Wait for an async fire-and-forget publish to complete
function wait(ms = 200) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("mind-activity-tracker", () => {
  const received: Array<ActivityEvent & { id: number; created_at: string }> = [];
  let unsub: () => void;

  before(async () => {
    // Pre-initialize DB (runs migrations) so publish() doesn't need to wait
    await getDb();
    unsub = subscribe((e) => received.push(e));
  });

  after(() => {
    unsub();
  });

  afterEach(() => {
    stopAll();
    received.length = 0;
  });

  test("session_start event transitions from idle to active", async () => {
    onMindEvent("test-mind", "session_start");
    await wait();
    const active = received.filter((e) => e.type === "mind_active" && e.mind === "test-mind");
    assert.equal(active.length, 1);
    assert.equal(active[0].summary, "test-mind is active");
  });

  test("text event also transitions from idle to active", async () => {
    onMindEvent("test-mind", "text", "volute:@alice");
    await wait();
    const active = received.filter((e) => e.type === "mind_active" && e.mind === "test-mind");
    assert.equal(active.length, 1);
  });

  test("repeated events do not re-publish active", async () => {
    onMindEvent("test-mind", "session_start");
    onMindEvent("test-mind", "text");
    onMindEvent("test-mind", "tool_use");
    await wait();
    const active = received.filter((e) => e.type === "mind_active" && e.mind === "test-mind");
    assert.equal(active.length, 1);
  });

  test("log and usage events are ignored", async () => {
    onMindEvent("test-mind", "log");
    onMindEvent("test-mind", "usage");
    await wait();
    const active = received.filter((e) => e.type === "mind_active");
    assert.equal(active.length, 0);
  });

  test("done event starts idle timer, not immediate idle", async () => {
    onMindEvent("test-mind", "session_start");
    await wait();
    received.length = 0;

    onMindEvent("test-mind", "done");
    await wait();
    // Should NOT be idle yet — timer pending (2 min)
    const idle = received.filter((e) => e.type === "mind_idle");
    assert.equal(idle.length, 0);
  });

  test("markIdle publishes mind_idle immediately", async () => {
    onMindEvent("test-mind", "session_start");
    await wait();
    received.length = 0;

    markIdle("test-mind");
    await wait();
    const idle = received.filter((e) => e.type === "mind_idle" && e.mind === "test-mind");
    assert.equal(idle.length, 1);
  });

  test("markIdle is no-op if already idle", async () => {
    markIdle("nonexistent");
    await wait();
    const idle = received.filter((e) => e.type === "mind_idle");
    assert.equal(idle.length, 0);
  });

  test("new activity after done cancels idle timer", async () => {
    onMindEvent("test-mind", "session_start");
    await wait();
    received.length = 0;

    onMindEvent("test-mind", "done");
    // New activity before idle fires
    onMindEvent("test-mind", "session_start");
    await wait();
    // Should not publish anything (still active, idle timer cancelled)
    assert.equal(received.length, 0);
  });

  test("stopAll cleans up timers", async () => {
    onMindEvent("mind-a", "session_start");
    onMindEvent("mind-b", "text");
    await wait();

    onMindEvent("mind-a", "done");
    onMindEvent("mind-b", "done");

    // Timers are pending — stopAll should clear them without error
    stopAll();
  });
});
