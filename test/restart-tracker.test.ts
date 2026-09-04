import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RestartTracker } from "../packages/daemon/src/lib/daemon/restart-tracker.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  // The bug in #1033: the counter was cleared at spawn, so a child that started
  // and died immediately refreshed its own budget on every attempt.
  describe("healthy reset", () => {
    it("clears the count once the child has stayed up past the base delay", async () => {
      const tracker = new RestartTracker({ maxAttempts: 3, baseDelay: 40 });
      tracker.recordCrash("a");
      tracker.recordCrash("a");
      assert.equal(tracker.getAttempts("a"), 2);

      tracker.armHealthyReset("a");
      assert.equal(tracker.getAttempts("a"), 2, "not reset before the threshold");

      await delay(120);
      assert.equal(tracker.getAttempts("a"), 0);
    });

    it("keeps the count when the child exits before the threshold", async () => {
      const tracker = new RestartTracker({ maxAttempts: 3, baseDelay: 40 });
      tracker.recordCrash("a");
      tracker.armHealthyReset("a");
      tracker.cancelHealthyReset("a"); // the child died

      await delay(120);
      assert.equal(tracker.getAttempts("a"), 1);
    });

    it("a fast-dying child still reaches maxAttempts", async () => {
      const tracker = new RestartTracker({ maxAttempts: 3, baseDelay: 40 });
      const delays: number[] = [];
      for (let i = 0; i < 4; i++) {
        // Each spawn arms a reset, then dies before it can fire.
        tracker.armHealthyReset("a");
        tracker.cancelHealthyReset("a");
        const { shouldRestart, delay: d } = tracker.recordCrash("a");
        if (!shouldRestart) break;
        delays.push(d);
      }
      await delay(120);
      assert.deepEqual(delays, [40, 80, 160]);
      assert.equal(tracker.recordCrash("a").shouldRestart, false);
    });

    it("re-arming cancels the previous timer", async () => {
      const tracker = new RestartTracker({ baseDelay: 300 });
      tracker.recordCrash("a");
      tracker.armHealthyReset("a"); // t=0, would fire at t=300
      await delay(150);
      tracker.armHealthyReset("a"); // a new spawn replaces the old one: fires at t=450
      await delay(250); // t=400 — past the first timer, before the second
      assert.equal(tracker.getAttempts("a"), 1, "the first timer must not fire");
      await delay(300);
      assert.equal(tracker.getAttempts("a"), 0);
    });

    it("fires the onReset callback only when a count was cleared", async () => {
      const tracker = new RestartTracker({ baseDelay: 30 });
      let calls = 0;
      tracker.armHealthyReset("clean", () => calls++);
      tracker.recordCrash("dirty");
      tracker.armHealthyReset("dirty", () => calls++);
      await delay(100);
      assert.equal(calls, 1);
    });

    it("reset and clear cancel pending timers", async () => {
      const tracker = new RestartTracker({ baseDelay: 30 });
      let calls = 0;
      tracker.recordCrash("a");
      tracker.armHealthyReset("a", () => calls++);
      tracker.reset("a");
      tracker.recordCrash("b");
      tracker.armHealthyReset("b", () => calls++);
      tracker.clear();

      tracker.recordCrash("a");
      tracker.recordCrash("b");
      await delay(100);
      assert.equal(calls, 0);
      assert.equal(tracker.getAttempts("a"), 1);
      assert.equal(tracker.getAttempts("b"), 1);
    });

    it("does not hold the process open on a pending reset", () => {
      const tracker = new RestartTracker({ baseDelay: 30 });
      tracker.armHealthyReset("a");
      const timer: NodeJS.Timeout = (tracker as any).healthyTimers.get("a");
      assert.equal(timer.hasRef(), false, "the pending reset must be unref'd");
      tracker.cancelHealthyReset("a");
    });
  });
});
