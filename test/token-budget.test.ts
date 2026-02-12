import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TokenBudget } from "../src/lib/token-budget.js";

describe("TokenBudget", () => {
  it("returns ok when no budget is configured", () => {
    const tb = new TokenBudget();
    assert.equal(tb.checkBudget("agent1"), "ok");
  });

  it("setBudget / removeBudget lifecycle", () => {
    const tb = new TokenBudget();
    tb.setBudget("agent1", 10000, 60);
    assert.notEqual(tb.getUsage("agent1"), null);

    tb.removeBudget("agent1");
    assert.equal(tb.getUsage("agent1"), null);
    assert.equal(tb.checkBudget("agent1"), "ok");
  });

  it("recordUsage accumulates input + output tokens", () => {
    const tb = new TokenBudget();
    tb.setBudget("agent1", 10000, 60);

    tb.recordUsage("agent1", 100, 200);
    assert.equal(tb.getUsage("agent1")!.tokensUsed, 300);

    tb.recordUsage("agent1", 50, 150);
    assert.equal(tb.getUsage("agent1")!.tokensUsed, 500);
  });

  it("recordUsage is a no-op for agents without a budget", () => {
    const tb = new TokenBudget();
    tb.recordUsage("unknown", 100, 200);
    assert.equal(tb.getUsage("unknown"), null);
  });

  it("checkBudget returns ok under 80%", () => {
    const tb = new TokenBudget();
    tb.setBudget("agent1", 10000, 60);
    tb.recordUsage("agent1", 3000, 4000); // 70%
    assert.equal(tb.checkBudget("agent1"), "ok");
  });

  it("checkBudget returns warning at 80% threshold", () => {
    const tb = new TokenBudget();
    tb.setBudget("agent1", 10000, 60);
    tb.recordUsage("agent1", 4000, 4000); // 80%
    assert.equal(tb.checkBudget("agent1"), "warning");
  });

  it("checkBudget returns ok after warning already injected", () => {
    const tb = new TokenBudget();
    tb.setBudget("agent1", 10000, 60);
    tb.recordUsage("agent1", 4500, 4500); // 90%
    assert.equal(tb.checkBudget("agent1"), "warning"); // first time
    assert.equal(tb.checkBudget("agent1"), "ok"); // already warned
  });

  it("checkBudget returns exceeded at 100%", () => {
    const tb = new TokenBudget();
    tb.setBudget("agent1", 10000, 60);
    tb.recordUsage("agent1", 5000, 5000); // 100%
    assert.equal(tb.checkBudget("agent1"), "exceeded");
  });

  it("checkBudget returns exceeded above 100%", () => {
    const tb = new TokenBudget();
    tb.setBudget("agent1", 10000, 60);
    tb.recordUsage("agent1", 6000, 6000); // 120%
    assert.equal(tb.checkBudget("agent1"), "exceeded");
  });

  it("enqueue and drain work correctly", () => {
    const tb = new TokenBudget();
    tb.setBudget("agent1", 10000, 60);

    const msg1 = {
      body: "{}",
      channel: "ch1",
      sender: "user1",
      textContent: "hello",
      timestamp: 1,
    };
    const msg2 = {
      body: "{}",
      channel: "ch2",
      sender: "user2",
      textContent: "world",
      timestamp: 2,
    };

    tb.enqueue("agent1", msg1);
    tb.enqueue("agent1", msg2);

    assert.equal(tb.getUsage("agent1")!.queueLength, 2);

    const drained = tb.drain("agent1");
    assert.equal(drained.length, 2);
    assert.equal(drained[0].textContent, "hello");
    assert.equal(drained[1].textContent, "world");

    assert.equal(tb.getUsage("agent1")!.queueLength, 0);
  });

  it("drain returns empty array for unknown agent", () => {
    const tb = new TokenBudget();
    assert.deepEqual(tb.drain("unknown"), []);
  });

  it("enqueue is a no-op for agents without a budget", () => {
    const tb = new TokenBudget();
    tb.enqueue("unknown", {
      body: "{}",
      channel: "ch",
      sender: null,
      textContent: "hi",
      timestamp: 1,
    });
    assert.deepEqual(tb.drain("unknown"), []);
  });

  it("tick resets expired periods", () => {
    const tb = new TokenBudget();
    tb.setBudget("agent1", 10000, 1); // 1-minute period

    tb.recordUsage("agent1", 5000, 5000);
    assert.equal(tb.getUsage("agent1")!.tokensUsed, 10000);

    // Use a 0-minute period budget to test tick reset
    const tb2 = new TokenBudget();
    tb2.setBudget("agent2", 10000, 0); // 0 minutes = already expired on next tick
    tb2.recordUsage("agent2", 3000, 3000);

    // Mark warning as injected
    tb2.checkBudget("agent2"); // should be warning at 60%... actually 60% < 80%, so ok
    tb2.recordUsage("agent2", 2000, 2000); // now at 100%

    tb2.tick();

    // After tick, period should have reset since 0-minute period is always expired
    assert.equal(tb2.getUsage("agent2")!.tokensUsed, 0);
  });

  it("tick resets warningInjected flag", () => {
    const tb = new TokenBudget();
    tb.setBudget("agent1", 10000, 0); // 0-minute period

    tb.recordUsage("agent1", 4500, 4500); // 90%
    assert.equal(tb.checkBudget("agent1"), "warning");
    assert.equal(tb.checkBudget("agent1"), "ok"); // already warned

    tb.tick(); // resets period

    // After reset, new usage at 90% should trigger warning again
    tb.recordUsage("agent1", 4500, 4500);
    assert.equal(tb.checkBudget("agent1"), "warning");
  });

  it("getUsage returns correct percentUsed", () => {
    const tb = new TokenBudget();
    tb.setBudget("agent1", 10000, 60);
    tb.recordUsage("agent1", 2500, 2500);

    const usage = tb.getUsage("agent1")!;
    assert.equal(usage.percentUsed, 50);
    assert.equal(usage.tokenLimit, 10000);
    assert.equal(usage.periodMinutes, 60);
  });

  it("setBudget preserves existing state when updating limits", () => {
    const tb = new TokenBudget();
    tb.setBudget("agent1", 10000, 60);
    tb.recordUsage("agent1", 3000, 2000);

    // Update budget limit
    tb.setBudget("agent1", 20000, 120);

    const usage = tb.getUsage("agent1")!;
    assert.equal(usage.tokensUsed, 5000); // preserved
    assert.equal(usage.tokenLimit, 20000); // updated
    assert.equal(usage.periodMinutes, 120); // updated
  });

  it("start and stop manage interval", () => {
    const tb = new TokenBudget();
    tb.start(4200, "token123");
    tb.stop();
    assert.ok(true);
  });
});
