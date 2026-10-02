import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { restartOntoMerge } from "../packages/daemon/src/lib/mind/merge-restart.js";

/**
 * The restart that puts a mind onto merged source, shared by an upgrade and a variant
 * join. A mind the sleep manager put to sleep while the merge ran must stay down for
 * its wake, with the merge context kept for that wake's start (#1309).
 */

const MIND = "test-mind";
const CONTEXT = { type: "merged", name: "test-mind-var" };

function fakeManager(up: boolean) {
  const calls: string[] = [];
  const contexts: Record<string, unknown>[] = [];
  return {
    calls,
    contexts,
    isUpOrRecovering: () => up,
    stopMind: async () => {
      calls.push("stop");
    },
    startMind: async () => {
      calls.push("start");
    },
    setPendingContext: (_name: string, context: Record<string, unknown>) => {
      calls.push("context");
      contexts.push(context);
    },
  };
}

describe("restartOntoMerge", () => {
  it("stops, sets the context, and starts an awake mind", async () => {
    const manager = fakeManager(true);
    const result = await restartOntoMerge(manager, MIND, CONTEXT, { isAsleep: () => false });
    assert.equal(result, "started");
    assert.deepEqual(manager.calls, ["stop", "context", "start"]);
  });

  it("leaves a sleeping mind down, its context kept for the wake", async () => {
    const manager = fakeManager(false);
    const result = await restartOntoMerge(manager, MIND, CONTEXT, { isAsleep: () => true });
    assert.equal(result, "asleep");
    assert.deepEqual(manager.calls, ["context"]);
    assert.deepEqual(manager.contexts, [CONTEXT]);
  });

  it("asks about sleep after the stop, so a sleep that lands during it is honoured", async () => {
    const manager = fakeManager(true);
    let asleep = false;
    manager.stopMind = async () => {
      manager.calls.push("stop");
      asleep = true;
    };
    const result = await restartOntoMerge(manager, MIND, CONTEXT, { isAsleep: () => asleep });
    assert.equal(result, "asleep");
    assert.deepEqual(manager.calls, ["stop", "context"]);
  });
});

describe("merge restart callers", () => {
  // The helper's sleep check only protects the paths that go through it. Both the
  // upgrade's and the join's restart must, rather than calling startMind themselves.
  const src = (p: string) =>
    readFileSync(resolve(import.meta.dirname, "../packages/daemon/src", p), "utf8");

  for (const file of ["lib/mind/upgrade.ts", "web/api/variants.ts"]) {
    it(`${file} restarts through restartOntoMerge`, () => {
      const text = src(file);
      assert.match(text, /restartOntoMerge\(manager,/);
      assert.doesNotMatch(text, /\.startMind\(/);
    });
  }
});
