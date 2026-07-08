import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSeedOrientation } from "../packages/daemon/src/lib/daemon/mind-service.js";

describe("buildSeedOrientation", () => {
  it("omits the creator claim when there is no creator", () => {
    const msg = buildSeedOrientation();
    assert.ok(msg.includes("You've just been created as a seed"));
    assert.ok(!msg.includes("Your creator"), "no creator line without a creator");
    // Never assumes a human planted the seed
    assert.ok(!msg.toLowerCase().includes("human"));
  });

  it("names a human (brain) creator plainly", () => {
    const msg = buildSeedOrientation("alice", "brain");
    assert.ok(msg.includes("Your creator is alice."));
    assert.ok(!msg.toLowerCase().includes("human"));
  });

  it("words a mind creator as another mind", () => {
    const msg = buildSeedOrientation("orchid", "mind");
    assert.ok(msg.includes("Your creator is another mind, orchid."));
  });

  it("words the spirit (system) creator as the spirit of this system", () => {
    const msg = buildSeedOrientation("volute", "system");
    assert.ok(msg.includes("Your creator is the spirit of this system (volute)."));
  });

  it("falls back to the bare name when the creator type is unknown", () => {
    const msg = buildSeedOrientation("someone");
    assert.ok(msg.includes("Your creator is someone."));
  });
});
