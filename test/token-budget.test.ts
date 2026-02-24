import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { TokenBudget } from "../src/lib/daemon/token-budget.js";

describe("TokenBudget", () => {
  // Clean up persisted budget state between tests to ensure isolation
  beforeEach(() => {
    const stateBase = resolve(process.env.VOLUTE_HOME!, "state");
    try {
      rmSync(stateBase, { recursive: true, force: true });
    } catch {}
  });
  it("returns ok when no budget is configured", () => {
    const tb = new TokenBudget();
    assert.equal(tb.checkBudget("mind1"), "ok");
  });

  it("setBudget / removeBudget lifecycle", () => {
    const tb = new TokenBudget();
    tb.setBudget("mind1", 10000, 60);
    assert.notEqual(tb.getUsage("mind1"), null);

    tb.removeBudget("mind1");
    assert.equal(tb.getUsage("mind1"), null);
    assert.equal(tb.checkBudget("mind1"), "ok");
  });

  it("setBudget rejects zero or negative tokenLimit", () => {
    const tb = new TokenBudget();
    tb.setBudget("mind1", 0, 60);
    assert.equal(tb.getUsage("mind1"), null);

    tb.setBudget("mind2", -100, 60);
    assert.equal(tb.getUsage("mind2"), null);
  });

  it("recordUsage accumulates input + output tokens", () => {
    const tb = new TokenBudget();
    tb.setBudget("mind1", 10000, 60);

    tb.recordUsage("mind1", 100, 200);
    assert.equal(tb.getUsage("mind1")!.tokensUsed, 300);

    tb.recordUsage("mind1", 50, 150);
    assert.equal(tb.getUsage("mind1")!.tokensUsed, 500);
  });

  it("recordUsage is a no-op for minds without a budget", () => {
    const tb = new TokenBudget();
    tb.recordUsage("unknown", 100, 200);
    assert.equal(tb.getUsage("unknown"), null);
  });

  it("checkBudget returns ok under 80%", () => {
    const tb = new TokenBudget();
    tb.setBudget("mind1", 10000, 60);
    tb.recordUsage("mind1", 3000, 4000); // 70%
    assert.equal(tb.checkBudget("mind1"), "ok");
  });

  it("checkBudget returns warning at 80% threshold", () => {
    const tb = new TokenBudget();
    tb.setBudget("mind1", 10000, 60);
    tb.recordUsage("mind1", 4000, 4000); // 80%
    assert.equal(tb.checkBudget("mind1"), "warning");
  });

  it("checkBudget returns warning repeatedly until acknowledged", () => {
    const tb = new TokenBudget();
    tb.setBudget("mind1", 10000, 60);
    tb.recordUsage("mind1", 4500, 4500); // 90%
    assert.equal(tb.checkBudget("mind1"), "warning");
    assert.equal(tb.checkBudget("mind1"), "warning"); // still warning — not yet acknowledged

    tb.acknowledgeWarning("mind1");
    assert.equal(tb.checkBudget("mind1"), "ok"); // now acknowledged
  });

  it("checkBudget returns exceeded at 100%", () => {
    const tb = new TokenBudget();
    tb.setBudget("mind1", 10000, 60);
    tb.recordUsage("mind1", 5000, 5000); // 100%
    assert.equal(tb.checkBudget("mind1"), "exceeded");
  });

  it("checkBudget returns exceeded above 100%", () => {
    const tb = new TokenBudget();
    tb.setBudget("mind1", 10000, 60);
    tb.recordUsage("mind1", 6000, 6000); // 120%
    assert.equal(tb.checkBudget("mind1"), "exceeded");
  });

  it("checkBudget returns exceeded when warning was acknowledged then usage crosses 100%", () => {
    const tb = new TokenBudget();
    tb.setBudget("mind1", 10000, 60);
    tb.recordUsage("mind1", 4500, 4500); // 90%
    assert.equal(tb.checkBudget("mind1"), "warning");
    tb.acknowledgeWarning("mind1");

    tb.recordUsage("mind1", 1000, 0); // now 100%
    assert.equal(tb.checkBudget("mind1"), "exceeded");
  });

  it("enqueue and drain work correctly", () => {
    const tb = new TokenBudget();
    tb.setBudget("mind1", 10000, 60);

    const msg1 = { channel: "ch1", sender: "user1", textContent: "hello" };
    const msg2 = { channel: "ch2", sender: "user2", textContent: "world" };

    tb.enqueue("mind1", msg1);
    tb.enqueue("mind1", msg2);

    assert.equal(tb.getUsage("mind1")!.queueLength, 2);

    const drained = tb.drain("mind1");
    assert.equal(drained.length, 2);
    assert.equal(drained[0].textContent, "hello");
    assert.equal(drained[1].textContent, "world");

    assert.equal(tb.getUsage("mind1")!.queueLength, 0);
  });

  it("enqueue drops oldest when queue is full", () => {
    const tb = new TokenBudget();
    tb.setBudget("mind1", 10000, 60);

    for (let i = 0; i < 100; i++) {
      tb.enqueue("mind1", { channel: "ch", sender: null, textContent: `msg-${i}` });
    }
    assert.equal(tb.getUsage("mind1")!.queueLength, 100);

    // Adding one more should drop the oldest
    tb.enqueue("mind1", { channel: "ch", sender: null, textContent: "msg-100" });
    assert.equal(tb.getUsage("mind1")!.queueLength, 100);

    const drained = tb.drain("mind1");
    assert.equal(drained[0].textContent, "msg-1"); // msg-0 was dropped
    assert.equal(drained[99].textContent, "msg-100");
  });

  it("drain returns empty array for unknown mind", () => {
    const tb = new TokenBudget();
    assert.deepEqual(tb.drain("unknown"), []);
  });

  it("enqueue is a no-op for minds without a budget", () => {
    const tb = new TokenBudget();
    tb.enqueue("unknown", { channel: "ch", sender: null, textContent: "hi" });
    assert.deepEqual(tb.drain("unknown"), []);
  });

  it("tick resets expired periods", () => {
    const tb = new TokenBudget();
    tb.setBudget("mind1", 10000, 0); // 0 minutes = always expired on tick

    tb.recordUsage("mind1", 5000, 5000);
    assert.equal(tb.getUsage("mind1")!.tokensUsed, 10000);

    tb.tick();

    assert.equal(tb.getUsage("mind1")!.tokensUsed, 0);
  });

  it("tick drains queue on period reset", () => {
    const tb = new TokenBudget();
    tb.setBudget("mind1", 10000, 0);

    tb.enqueue("mind1", { channel: "ch", sender: null, textContent: "queued" });
    assert.equal(tb.getUsage("mind1")!.queueLength, 1);

    // tick() resets the period and drains the queue for replay
    tb.tick();

    // Queue is drained (deliverMessage handles delivery or logs if mind not found)
    assert.equal(tb.getUsage("mind1")!.queueLength, 0);
  });

  it("tick does not reset unexpired periods", () => {
    const tb = new TokenBudget();
    tb.setBudget("mind1", 10000, 9999); // very long period

    tb.recordUsage("mind1", 5000, 5000);
    tb.tick();

    assert.equal(tb.getUsage("mind1")!.tokensUsed, 10000); // NOT reset
  });

  it("tick resets warningInjected flag", () => {
    const tb = new TokenBudget();
    tb.setBudget("mind1", 10000, 0); // 0-minute period

    tb.recordUsage("mind1", 4500, 4500); // 90%
    assert.equal(tb.checkBudget("mind1"), "warning");
    tb.acknowledgeWarning("mind1");
    assert.equal(tb.checkBudget("mind1"), "ok"); // already acknowledged

    tb.tick(); // resets period

    // After reset, new usage at 90% should trigger warning again
    tb.recordUsage("mind1", 4500, 4500);
    assert.equal(tb.checkBudget("mind1"), "warning");
  });

  it("getUsage returns correct percentUsed", () => {
    const tb = new TokenBudget();
    tb.setBudget("mind1", 10000, 60);
    tb.recordUsage("mind1", 2500, 2500);

    const usage = tb.getUsage("mind1")!;
    assert.equal(usage.percentUsed, 50);
    assert.equal(usage.tokenLimit, 10000);
    assert.equal(usage.periodMinutes, 60);
  });

  it("setBudget preserves existing state when updating limits", () => {
    const tb = new TokenBudget();
    tb.setBudget("mind1", 10000, 60);
    tb.recordUsage("mind1", 3000, 2000);

    // Update budget limit
    tb.setBudget("mind1", 20000, 120);

    const usage = tb.getUsage("mind1")!;
    assert.equal(usage.tokensUsed, 5000); // preserved
    assert.equal(usage.tokenLimit, 20000); // updated
    assert.equal(usage.periodMinutes, 120); // updated
  });

  it("minds are tracked independently", () => {
    const tb = new TokenBudget();
    tb.setBudget("a", 10000, 60);
    tb.setBudget("b", 10000, 60);
    tb.recordUsage("a", 5000, 5000); // 100%
    assert.equal(tb.checkBudget("a"), "exceeded");
    assert.equal(tb.checkBudget("b"), "ok");
  });

  it("persists budget state across instances", () => {
    const tb1 = new TokenBudget();
    tb1.setBudget("mind1", 10000, 60);
    tb1.recordUsage("mind1", 3000, 2000); // 5000 tokens used
    tb1.flush();

    // New instance should load persisted state
    const tb2 = new TokenBudget();
    tb2.setBudget("mind1", 10000, 60);
    assert.equal(tb2.getUsage("mind1")!.tokensUsed, 5000);
  });

  it("persists warningInjected flag via flush", () => {
    const tb1 = new TokenBudget();
    tb1.setBudget("mind1", 10000, 60);
    tb1.recordUsage("mind1", 4500, 4500); // 90%
    assert.equal(tb1.checkBudget("mind1"), "warning");
    tb1.acknowledgeWarning("mind1");
    tb1.flush();

    const tb2 = new TokenBudget();
    tb2.setBudget("mind1", 10000, 60);
    // warningInjected was persisted, so checkBudget should return ok (already acknowledged)
    assert.equal(tb2.checkBudget("mind1"), "ok");
  });

  it("persists queued messages via flush", () => {
    const tb1 = new TokenBudget();
    tb1.setBudget("mind1", 10000, 60);
    tb1.recordUsage("mind1", 5000, 5000); // exceed budget
    tb1.enqueue("mind1", { channel: "ch1", sender: "user1", textContent: "hello" });
    tb1.enqueue("mind1", { channel: "ch2", sender: null, textContent: "world" });
    tb1.flush();

    const tb2 = new TokenBudget();
    tb2.setBudget("mind1", 10000, 60);
    assert.equal(tb2.getUsage("mind1")!.queueLength, 2);

    const drained = tb2.drain("mind1");
    assert.equal(drained[0].textContent, "hello");
    assert.equal(drained[1].textContent, "world");
  });

  it("handles missing budget state file gracefully", () => {
    const tb = new TokenBudget();
    tb.setBudget("nonexistent-mind", 10000, 60);
    assert.equal(tb.getUsage("nonexistent-mind")!.tokensUsed, 0);
  });

  it("start and stop manage interval", () => {
    const tb = new TokenBudget();
    tb.start();
    tb.stop();
    assert.ok(true);
  });
});
