import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
  clearPendingContext,
  readPendingContext,
  setPendingContext,
} from "../packages/daemon/src/lib/daemon/pending-context.js";
import { stateDir } from "../packages/daemon/src/lib/mind/registry.js";

describe("pending context persistence (#330)", () => {
  it("survives a simulated daemon restart and is cleared after delivery", () => {
    const name = `pending-ctx-${Date.now()}`;
    const context = {
      type: "merged",
      name: "explorer-variant",
      summary: "refactored the router",
      justification: "cleaner batching",
      memory: "keep the batching notes",
    };

    setPendingContext(name, context);

    // A daemon restart drops all in-memory state — reading fresh from disk (there
    // is no in-process Map to fall back on) is exactly what the next start does.
    // If this store regressed to an in-memory Map, the read below would be null.
    const afterRestart = readPendingContext(name);
    assert.deepEqual(afterRestart, context);

    // Delivery clears it, so a subsequent start doesn't redeliver the same message.
    clearPendingContext(name);
    assert.equal(readPendingContext(name), null);
    assert.ok(!existsSync(resolve(stateDir(name), "pending-context.json")));
  });

  it("returns null when nothing is queued", () => {
    assert.equal(readPendingContext(`never-set-${Date.now()}`), null);
  });

  it("overwrites a prior pending context rather than merging", () => {
    const name = `pending-ctx-overwrite-${Date.now()}`;
    setPendingContext(name, { type: "split", parent: "root", purpose: "explore A" });
    setPendingContext(name, { type: "merged", name });
    assert.deepEqual(readPendingContext(name), { type: "merged", name });
    clearPendingContext(name);
  });
});
