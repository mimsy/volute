import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  getMemoryDetail,
  getMemoryStatus,
  MEMORY_HARD_CAP_TOKENS,
  MEMORY_SOFT_BUDGET_TOKENS,
  parseMemorySections,
  printableHeading,
} from "../packages/daemon/src/lib/mind/memory-size.js";
import { memorySections } from "../templates/_base/src/lib/startup.js";

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

  it("estimates tokens as chars/4 with default budgets", () => {
    const status = getMemoryStatus(makeProject("m".repeat(4000)));
    assert.ok(status);
    assert.equal(status.bytes, 4000);
    assert.equal(status.chars, 4000);
    assert.equal(status.estTokens, 1000);
    assert.equal(status.softBudgetTokens, MEMORY_SOFT_BUDGET_TOKENS);
    assert.equal(status.hardCapTokens, MEMORY_HARD_CAP_TOKENS);
    assert.equal(status.overBudget, false);
    assert.equal(status.overHardCap, false);
  });

  it("estimates from chars, not bytes, so multibyte content matches what the template loads", () => {
    // 1000 CJK chars = 3000 UTF-8 bytes. The template's buildMemorySection
    // estimates chars/4; a bytes-based daemon estimate would claim truncation
    // the mind never experiences.
    const status = getMemoryStatus(makeProject("語".repeat(1000)));
    assert.ok(status);
    assert.equal(status.bytes, 3000);
    assert.equal(status.estTokens, 250);
  });

  it("default budgets match the template's constants", async () => {
    // The daemon flags what the template enforces; if these drift, status
    // reports truncation that isn't happening (or misses one that is).
    const template = await import("../templates/_base/src/lib/startup.js");
    assert.equal(MEMORY_SOFT_BUDGET_TOKENS, template.MEMORY_SOFT_BUDGET_TOKENS);
    assert.equal(MEMORY_HARD_CAP_TOKENS, template.MEMORY_HARD_CAP_TOKENS);
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

describe("MEMORY.md sections (#954, #1124)", () => {
  const sample = [
    "Loose preamble line",
    "# Memory",
    "## Identity",
    "who I am",
    "### A subsection stays inside Identity",
    "detail",
    "```md",
    "## not a heading — inside a fence",
    "```",
    "## Right now",
    "today",
    "#hashtag is not a heading",
  ].join("\n");

  it("splits at #/## headings outside fences; the preamble has a null heading", () => {
    const sections = parseMemorySections(sample);
    assert.deepEqual(
      sections.map((s) => s.heading),
      [null, "# Memory", "## Identity", "## Right now"],
    );
    assert.equal(
      sections.reduce((sum, s) => sum + s.chars, 0),
      sample.length,
      "sections tile the whole file",
    );
  });

  it("agrees with the template's split, which the overflow notice uses", () => {
    for (const text of [sample, "", "no headings at all", "## Only\nbody\n", "# A\n# B"]) {
      assert.deepEqual(
        parseMemorySections(text).map((s) => [s.heading, s.chars]),
        memorySections(text).map((s) => [s.heading, s.end - s.start]),
        JSON.stringify(text),
      );
    }
  });

  it("getMemoryDetail returns the status plus sections", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "memory-detail-"));
    try {
      mkdirSync(resolve(dir, "home"), { recursive: true });
      writeFileSync(resolve(dir, "home", "MEMORY.md"), "## A\naaaa\n## B\nbb");
      const detail = getMemoryDetail(dir);
      assert.ok(detail);
      assert.equal(detail.chars, 17);
      assert.deepEqual(
        detail.sections?.map((s) => [s.heading, s.chars]),
        [
          ["## A", 10],
          ["## B", 7],
        ],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("printableHeading", () => {
  it("strips ANSI, OSC and other control characters from mind-authored headings", () => {
    assert.equal(
      printableHeading(
        "## \x1b[31mred\x1b[0m \x1b]0;pwned\x07title \x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\ \rbell\x07\x9b",
      ),
      "## red title link bell",
    );
    assert.equal(printableHeading("## Plain — ünïcode ✓"), "## Plain — ünïcode ✓");
  });
});
