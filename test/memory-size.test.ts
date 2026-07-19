import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  getMemoryStatus,
  MEMORY_HARD_CAP_TOKENS,
  MEMORY_SOFT_BUDGET_TOKENS,
} from "../packages/daemon/src/lib/mind/memory-size.js";

describe("getMemoryStatus", () => {
  const scratch: string[] = [];
  afterEach(() => {
    for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function makeProject(memory?: string, config?: object): string {
    const dir = mkdtempSync(resolve(tmpdir(), "memory-size-"));
    scratch.push(dir);
    mkdirSync(resolve(dir, "home", ".config"), { recursive: true });
    if (memory !== undefined) writeFileSync(resolve(dir, "home", "MEMORY.md"), memory);
    if (config)
      writeFileSync(resolve(dir, "home", ".config", "config.json"), JSON.stringify(config));
    return dir;
  }

  it("returns null when MEMORY.md doesn't exist", () => {
    assert.equal(getMemoryStatus(makeProject()), null);
  });

  it("estimates tokens as bytes/4 with default budgets", () => {
    const status = getMemoryStatus(makeProject("m".repeat(4000)));
    assert.ok(status);
    assert.equal(status.bytes, 4000);
    assert.equal(status.estTokens, 1000);
    assert.equal(status.softBudgetTokens, MEMORY_SOFT_BUDGET_TOKENS);
    assert.equal(status.hardCapTokens, MEMORY_HARD_CAP_TOKENS);
    assert.equal(status.overBudget, false);
    assert.equal(status.overHardCap, false);
  });

  it("flags over-budget past the soft budget, over-hard-cap past the cap", () => {
    // 40,000 bytes ≈ 10k tokens: over the 5k soft budget, under the 25k cap.
    const soft = getMemoryStatus(makeProject("m".repeat(40_000)));
    assert.ok(soft);
    assert.equal(soft.overBudget, true);
    assert.equal(soft.overHardCap, false);

    // 120,000 bytes ≈ 30k tokens: over both.
    const hard = getMemoryStatus(makeProject("m".repeat(120_000)));
    assert.ok(hard);
    assert.equal(hard.overBudget, true);
    assert.equal(hard.overHardCap, true);
  });

  it("honors budget overrides from home/.config/config.json", () => {
    const status = getMemoryStatus(
      makeProject("m".repeat(400), { memory: { softBudgetTokens: 50, hardCapTokens: 80 } }),
    );
    assert.ok(status);
    assert.equal(status.estTokens, 100);
    assert.equal(status.softBudgetTokens, 50);
    assert.equal(status.hardCapTokens, 80);
    assert.equal(status.overBudget, true);
    assert.equal(status.overHardCap, true);
  });

  it("falls back to defaults on malformed config.json", () => {
    const dir = makeProject("m".repeat(8));
    writeFileSync(resolve(dir, "home", ".config", "config.json"), "{not json");
    const status = getMemoryStatus(dir);
    assert.ok(status);
    assert.equal(status.softBudgetTokens, MEMORY_SOFT_BUDGET_TOKENS);
  });
});
