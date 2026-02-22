import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RestartTracker } from "../src/lib/restart-tracker.js";

describe("RestartTracker", () => {
  it("allows restarts up to maxAttempts", () => {
    const tracker = new RestartTracker({ maxAttempts: 3 });

    const r1 = tracker.recordCrash("a");
    assert.equal(r1.shouldRestart, true);
    assert.equal(r1.attempt, 1);

    const r2 = tracker.recordCrash("a");
    assert.equal(r2.shouldRestart, true);
    assert.equal(r2.attempt, 2);

    const r3 = tracker.recordCrash("a");
    assert.equal(r3.shouldRestart, true);
    assert.equal(r3.attempt, 3);

    const r4 = tracker.recordCrash("a");
    assert.equal(r4.shouldRestart, false);
  });

  it("uses exponential backoff for delay", () => {
    const tracker = new RestartTracker({ baseDelay: 1000, maxDelay: 16000 });

    const r1 = tracker.recordCrash("a");
    assert.equal(r1.delay, 1000); // 1000 * 2^0

    const r2 = tracker.recordCrash("a");
    assert.equal(r2.delay, 2000); // 1000 * 2^1

    const r3 = tracker.recordCrash("a");
    assert.equal(r3.delay, 4000); // 1000 * 2^2

    const r4 = tracker.recordCrash("a");
    assert.equal(r4.delay, 8000); // 1000 * 2^3

    const r5 = tracker.recordCrash("a");
    assert.equal(r5.delay, 16000); // capped at maxDelay
  });

  it("reset clears attempts for a key", () => {
    const tracker = new RestartTracker({ maxAttempts: 3 });
    tracker.recordCrash("a");
    tracker.recordCrash("a");
    assert.equal(tracker.getAttempts("a"), 2);

    tracker.reset("a");
    assert.equal(tracker.getAttempts("a"), 0);

    // Can restart again after reset
    const r = tracker.recordCrash("a");
    assert.equal(r.shouldRestart, true);
    assert.equal(r.attempt, 1);
  });

  it("tracks keys independently", () => {
    const tracker = new RestartTracker({ maxAttempts: 2 });
    tracker.recordCrash("a");
    tracker.recordCrash("a");
    const ra = tracker.recordCrash("a");
    assert.equal(ra.shouldRestart, false);

    const rb = tracker.recordCrash("b");
    assert.equal(rb.shouldRestart, true);
  });

  it("save and load round-trip", () => {
    const tracker = new RestartTracker();
    tracker.recordCrash("a");
    tracker.recordCrash("a");
    tracker.recordCrash("b");

    const data = tracker.save();

    const tracker2 = new RestartTracker();
    tracker2.load(data);
    assert.equal(tracker2.getAttempts("a"), 2);
    assert.equal(tracker2.getAttempts("b"), 1);
  });

  it("clear removes all attempts", () => {
    const tracker = new RestartTracker();
    tracker.recordCrash("a");
    tracker.recordCrash("b");
    tracker.clear();
    assert.equal(tracker.getAttempts("a"), 0);
    assert.equal(tracker.getAttempts("b"), 0);
  });

  it("uses default values", () => {
    const tracker = new RestartTracker();
    assert.equal(tracker.maxRestartAttempts, 5);

    const r = tracker.recordCrash("a");
    assert.equal(r.delay, 3000);
  });
});
