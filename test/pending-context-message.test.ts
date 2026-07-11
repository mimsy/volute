import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPendingContextMessage } from "../packages/daemon/src/lib/daemon/mind-manager.js";

describe("buildPendingContextMessage", () => {
  it("orients a split variant with its identity, parent, and purpose", async () => {
    const msg = await buildPendingContextMessage("atlas-exp", {
      type: "split",
      parent: "atlas",
      purpose: "test a drier journaling voice",
    });
    assert.ok(msg.includes("atlas-exp"), "names the variant");
    assert.ok(msg.includes("atlas"), "names the parent");
    assert.ok(
      msg.includes("Why you were split off: test a drier journaling voice"),
      "includes the purpose line",
    );
  });

  it("omits the purpose line for a split with no purpose", async () => {
    const msg = await buildPendingContextMessage("atlas-exp", {
      type: "split",
      parent: "atlas",
    });
    assert.ok(msg.includes("atlas-exp"));
    assert.ok(!msg.includes("Why you were split off:"), "no purpose line when none given");
  });

  it("includes changes / justification / memory for a merge", async () => {
    const msg = await buildPendingContextMessage("atlas", {
      type: "merged",
      name: "atlas-exp",
      summary: "reworked the journal voice",
      justification: "the drier voice felt truer",
      memory: "keep the shorter entries",
    });
    assert.ok(msg.includes("Changes: reworked the journal voice"));
    assert.ok(msg.includes("Why: the drier voice felt truer"));
    assert.ok(msg.includes("Context: keep the shorter entries"));
  });
});
