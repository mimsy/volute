import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Mind } from "../packages/api/src/types.js";
import { findSpirit, showMindOnboarding } from "../packages/web/src/ui/lib/onboarding.js";

function mind(name: string, mindType?: "mind" | "spirit"): Mind {
  return {
    name,
    created: "2026-01-01T00:00:00Z",
    status: "running",
    channels: [],
    mindType,
  };
}

describe("showMindOnboarding", () => {
  it("is false while minds have not loaded", () => {
    assert.equal(showMindOnboarding([], false), false);
    assert.equal(showMindOnboarding([mind("volute", "spirit")], false), false);
  });

  it("is true when only the spirit exists", () => {
    assert.equal(showMindOnboarding([mind("volute", "spirit")], true), true);
  });

  it("is true when loaded and no minds exist at all (spirit bootstrap failed)", () => {
    assert.equal(showMindOnboarding([], true), true);
  });

  it("is false once a regular mind exists", () => {
    assert.equal(showMindOnboarding([mind("volute", "spirit"), mind("luna", "mind")], true), false);
  });

  it("treats minds without an explicit mindType as regular minds", () => {
    assert.equal(showMindOnboarding([mind("volute", "spirit"), mind("luna")], true), false);
  });
});

describe("findSpirit", () => {
  it("returns the spirit mind", () => {
    const spirit = mind("volute", "spirit");
    assert.equal(findSpirit([mind("luna", "mind"), spirit]), spirit);
  });

  it("returns undefined when no spirit exists", () => {
    assert.equal(findSpirit([mind("luna", "mind")]), undefined);
  });
});
