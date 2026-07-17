import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  initMindManager,
  tryGetMindManager,
} from "../packages/daemon/src/lib/daemon/mind-manager.js";
import { startMindFull } from "../packages/daemon/src/lib/daemon/mind-service.js";
import { getTokenBudget, initTokenBudget } from "../packages/daemon/src/lib/daemon/token-budget.js";
import { addMind, mindDir, removeMind } from "../packages/daemon/src/lib/mind/registry.js";

// #689: startMindFull's post-start tail (schedule/sleep-config load, token budget,
// extension notification) ran some steps bare, so a throw there turned a fully
// successful mind start into a rejected promise — which the restart route caught
// and turned into a 500, even though the mind process itself started fine. These
// steps are metadata/best-effort, not load-bearing for "did the mind start", so a
// throw in any of them must be caught and logged, not left to abort the function.
describe("startMindFull post-start tail is best-effort (#689)", () => {
  const mindName = `restart-tail-${process.pid}`;

  beforeEach(async () => {
    try {
      initTokenBudget();
    } catch {
      // already initialized by another test in this process
    }
    await removeMind(mindName);
    const dir = mindDir(mindName);
    mkdirSync(resolve(dir, "home/.config"), { recursive: true });
    // A configured token budget routes startMindFull through the (previously bare)
    // getTokenBudget().setBudget(...) call.
    writeFileSync(resolve(dir, "home/.config/volute.json"), JSON.stringify({ tokenBudget: 1000 }));
  });

  afterEach(async () => {
    await removeMind(mindName);
    getTokenBudget().removeBudget(mindName);
  });

  it("does not throw when a post-start step (token budget) throws", async () => {
    // Stub the mind manager so startMind is a no-op — we exercise startMindFull's
    // post-start tail, not a real process spawn (same pattern as orientation.test.ts).
    const mgr = tryGetMindManager() ?? initMindManager();
    const origStart = mgr.startMind;
    const origRunning = mgr.isRunning;
    mgr.startMind = async () => {};
    mgr.isRunning = () => false;

    const tb = getTokenBudget();
    const origSetBudget = tb.setBudget;
    tb.setBudget = () => {
      throw new Error("boom: simulated token-budget failure");
    };

    try {
      await addMind(mindName, 4999, "sprouted", "claude");
      await assert.doesNotReject(
        () => startMindFull(mindName),
        "a throw in a best-effort post-start step must not fail the whole start",
      );
    } finally {
      mgr.startMind = origStart;
      mgr.isRunning = origRunning;
      tb.setBudget = origSetBudget;
    }
  });
});
