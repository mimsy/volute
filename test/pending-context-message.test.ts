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

  it("delivers the variant's memory delta to the parent on merge", async () => {
    const delta = "diff --git a/home/MEMORY.md b/home/MEMORY.md\n+ variant learned to whistle";
    const content = await buildPendingContextMessage("parent", {
      type: "merged",
      name: "variant",
      summary: "did some work",
      memoryDelta: delta,
    });

    // The stringly-typed context seam must actually carry the delta through.
    assert.ok(content.includes(delta), `expected delta in delivered message:\n${content}`);
    assert.match(content, /not merged/);
    assert.match(content, /Changes: did some work/);
  });

  it("omits the delta section when there is no delta", async () => {
    const content = await buildPendingContextMessage("parent", {
      type: "merged",
      name: "variant",
    });
    assert.doesNotMatch(content, /not merged/);
  });

  it("folds the variant's farewell note into the merge message", async () => {
    const content = await buildPendingContextMessage("parent", {
      type: "merged",
      name: "variant",
      summary: "did some work",
      farewell: "Tell parent I found the answer in the margins.",
    });
    assert.match(content, /parting note/i);
    assert.match(content, /found the answer in the margins/);
    assert.match(content, /Changes: did some work/);
  });

  it("omits the parting-note section when there is no farewell", async () => {
    const content = await buildPendingContextMessage("parent", {
      type: "merged",
      name: "variant",
      summary: "did some work",
    });
    assert.doesNotMatch(content, /parting note/i);
  });
});
