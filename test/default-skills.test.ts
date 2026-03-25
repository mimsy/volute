import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SEED_SKILLS, STANDARD_SKILLS } from "../packages/daemon/src/lib/skills.js";

describe("default skills", () => {
  it("STANDARD_SKILLS contains expected skills", () => {
    assert.ok(STANDARD_SKILLS.includes("memory"));
    assert.ok(STANDARD_SKILLS.includes("volute-mind"));
    assert.ok(STANDARD_SKILLS.length > 0);
  });

  it("STANDARD_SKILLS has no duplicates", () => {
    const unique = new Set(STANDARD_SKILLS);
    assert.equal(unique.size, STANDARD_SKILLS.length);
  });

  it("SEED_SKILLS contains expected skills", () => {
    assert.ok(SEED_SKILLS.includes("orientation"));
    assert.ok(SEED_SKILLS.includes("memory"));
  });

  it("SEED_SKILLS has no duplicates", () => {
    const unique = new Set(SEED_SKILLS);
    assert.equal(unique.size, SEED_SKILLS.length);
  });
});
