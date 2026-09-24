import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadSystemPrompt } from "../templates/_base/src/lib/startup.js";

describe("loadSystemPrompt", () => {
  const origCwd = process.cwd();
  const scratch: string[] = [];
  afterEach(() => {
    process.chdir(origCwd);
    for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function makeHome(files: Record<string, string>): string {
    const dir = mkdtempSync(resolve(tmpdir(), "startup-prompt-"));
    scratch.push(dir);
    mkdirSync(resolve(dir, "home"), { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      const path = resolve(dir, "home", name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    return dir;
  }

  it("orders SOUL → SPIRIT → VOLUTE → Memory when SPIRIT.md exists", () => {
    const dir = makeHome({
      "SOUL.md": "SOUL-CONTENT",
      "SPIRIT.md": "SPIRIT-CONTENT",
      "VOLUTE.md": "VOLUTE-CONTENT",
      "MEMORY.md": "MEMORY-CONTENT",
    });
    process.chdir(dir);
    const prompt = loadSystemPrompt();
    const order = ["SOUL-CONTENT", "SPIRIT-CONTENT", "VOLUTE-CONTENT", "MEMORY-CONTENT"].map((s) =>
      prompt.indexOf(s),
    );
    assert.ok(
      order.every((i) => i >= 0),
      `all parts present: ${order}`,
    );
    assert.deepEqual(
      [...order].sort((a, b) => a - b),
      order,
    );
  });

  it("is unchanged for minds without SPIRIT.md, apart from the memory cost header", () => {
    const dir = makeHome({ "SOUL.md": "SOUL-CONTENT", "VOLUTE.md": "V", "MEMORY.md": "M" });
    process.chdir(dir);
    const prompt = loadSystemPrompt();
    assert.equal(
      prompt,
      "SOUL-CONTENT\n\n---\n\nV\n\n---\n\n## Memory (~0 tokens, always loaded — a chars/4 estimate, low for dense prose)\n\nM",
    );
  });

  it("renders the memory header with its estimated token cost (#569)", () => {
    // 4000 chars ≈ 1000 tokens.
    const dir = makeHome({ "SOUL.md": "S", "MEMORY.md": "m".repeat(4000) });
    process.chdir(dir);
    const prompt = loadSystemPrompt();
    assert.ok(
      prompt.includes(
        "## Memory (~1k tokens, always loaded — a chars/4 estimate, low for dense prose)",
      ),
      prompt.slice(0, 200),
    );
  });

  it("adds a consolidation nudge when memory exceeds the soft budget (#569)", () => {
    // 40,000 chars ≈ 10k tokens > the 5k default soft budget.
    const memory = "m".repeat(40_000);
    const dir = makeHome({ "SOUL.md": "S", "MEMORY.md": memory });
    process.chdir(dir);
    const prompt = loadSystemPrompt();
    assert.ok(
      prompt.includes(
        "## Memory (~10k tokens, always loaded — a chars/4 estimate, low for dense prose)",
      ),
    );
    assert.ok(prompt.includes("exceeds the recommended budget of ~5k tokens"));
    // Under the hard cap the content is fully loaded and there is no truncation notice.
    assert.ok(prompt.includes(memory));
    assert.ok(!prompt.includes("only the first"));
  });

  it("stays quiet under the soft budget", () => {
    const dir = makeHome({ "SOUL.md": "S", "MEMORY.md": "m".repeat(400) });
    process.chdir(dir);
    const prompt = loadSystemPrompt();
    assert.ok(!prompt.includes("exceeds the recommended budget"));
  });

  it("loads only the head, cut at a line boundary, when memory exceeds the hard cap (#569)", () => {
    // 1200 lines of 100 chars = 120,000 chars ≈ 30k tokens > the 25k default cap
    // (100,000 chars). Numbered lines make the cut point verifiable.
    const lines = Array.from({ length: 1200 }, (_, i) =>
      `line-${String(i).padStart(5, "0")} `.padEnd(99, "x"),
    );
    const memory = lines.join("\n");
    const memoryPath = resolve(makeHome({ "SOUL.md": "S", "MEMORY.md": memory }), "home/MEMORY.md");
    process.chdir(dirname(dirname(memoryPath)));
    const prompt = loadSystemPrompt();

    assert.ok(
      prompt.includes("⚠ MEMORY.md is ~30k tokens — only the first ~25k tokens are loaded"),
      "truncation notice present",
    );
    assert.ok(prompt.includes("The full file is untouched on disk"));
    assert.ok(prompt.includes("line-00000"), "head is loaded");
    assert.ok(!prompt.includes("line-01199"), "tail is not loaded");
    // Cut lands on a line boundary: every loaded line is complete (100,000 / 100
    // chars per line = the first 999 full lines survive, nothing partial).
    assert.ok(prompt.includes(lines[998]), "last full line before the cap is loaded");
    assert.ok(!prompt.includes("line-01000"), "lines past the cap are dropped whole");
    // The file on disk is never modified.
    assert.equal(readFileSync(memoryPath, "utf-8"), memory);
  });

  it("names every section that didn't load, and the one the cut lands in (#1124)", () => {
    // ~22.5k tokens of "Identity" loads whole; "Concepts" straddles the 25k cap
    // (100,000 chars); "Right now" — the newest, at the end — is past it.
    const memory = [
      "# Memory",
      "## Identity",
      "i".repeat(90_000),
      "## Concepts",
      "c".repeat(20_000),
      "```",
      "## inside a fence — not a section",
      "```",
      "## Right now",
      "r".repeat(4_000),
    ].join("\n");
    const dir = makeHome({ "SOUL.md": "S", "MEMORY.md": memory });
    process.chdir(dir);
    const prompt = loadSystemPrompt();

    // "Concepts" is one long line, so the cut lands on the newline after its heading.
    const notice = prompt.slice(prompt.indexOf("⚠"));
    assert.ok(notice.includes("These sections are not in your context"), notice);
    assert.ok(notice.includes("- ## Right now (~1k tokens)"), notice);
    assert.ok(
      notice.includes("- ## Concepts — cut partway: ~3 tokens of ~5k tokens loaded"),
      notice,
    );
    assert.ok(!prompt.includes("- ## Identity"), "a fully loaded section isn't listed");
    assert.ok(!prompt.includes("- # Memory"));
    assert.ok(!prompt.includes("- ## inside a fence"), "fenced lines aren't headings");
  });

  it("doesn't call a section that ends exactly at the cut partly loaded", () => {
    // Cap 25 tokens = 100 chars. "## A\n" + 94 chars ends at index 99, the newline
    // the line-boundary cut lands on, so A loads whole and only B is missing.
    const memory = `## A\n${"a".repeat(94)}\n## B\n${"b".repeat(200)}`;
    const dir = makeHome({
      "SOUL.md": "S",
      "MEMORY.md": memory,
      ".config/config.json": JSON.stringify({ memory: { hardCapTokens: 25 } }),
    });
    process.chdir(dir);
    const prompt = loadSystemPrompt();
    const notice = prompt.slice(prompt.indexOf("⚠"));
    assert.ok(prompt.includes("a".repeat(94)), "A is loaded whole");
    assert.ok(!notice.includes("- ## A"), notice);
    assert.ok(notice.includes("- ## B (~51 tokens)"), notice);
  });

  it("lists at most 20 unloaded sections, then a count, so the notice stays small", () => {
    // s0 still fits under the 100-char cap; s1–s49 are past it.
    const tail = Array.from({ length: 50 }, (_, i) => `## s${i}\nxxxx`).join("\n");
    const memory = `## head\n${"h".repeat(80)}\n${tail}`;
    const dir = makeHome({
      "SOUL.md": "S",
      "MEMORY.md": memory,
      ".config/config.json": JSON.stringify({ memory: { hardCapTokens: 25 } }),
    });
    process.chdir(dir);
    const prompt = loadSystemPrompt();
    const notice = prompt.slice(prompt.indexOf("⚠"));
    const listed = notice.split("\n").filter((l) => l.startsWith("- ## s"));
    assert.equal(listed.length, 20, notice);
    assert.ok(notice.includes("- …and 29 more sections (~"), notice);
    assert.ok(!notice.includes("- ## s49"), notice);
  });

  it("falls back to a hard cut when the only newline is near the start (one giant line)", () => {
    // A pathological MEMORY.md: a short heading, then one enormous single line.
    // A naive last-newline cut would collapse the loaded memory to the heading.
    const memory = `# Head\n${"x".repeat(120_000)}`;
    const dir = makeHome({ "SOUL.md": "S", "MEMORY.md": memory });
    process.chdir(dir);
    const prompt = loadSystemPrompt();
    assert.ok(prompt.includes("only the first ~25k tokens are loaded"));
    assert.ok(prompt.length > 90_000, `most of the allowed head is loaded (got ${prompt.length})`);
  });

  it("honors memory budget overrides from home/.config/config.json (#569)", () => {
    const memory = "A".repeat(60) + "\n" + "B".repeat(60) + "\n" + "C".repeat(60);
    const dir = makeHome({
      "SOUL.md": "S",
      "MEMORY.md": memory,
      ".config/config.json": JSON.stringify({ memory: { hardCapTokens: 25 } }),
    });
    process.chdir(dir);
    const prompt = loadSystemPrompt();
    // Hard cap 25 tokens = 100 chars: only the first 60-char line fits whole.
    assert.ok(prompt.includes("A".repeat(60)));
    assert.ok(!prompt.includes("B".repeat(60)));
    assert.ok(prompt.includes("only the first ~25 tokens are loaded"));

    const dir2 = makeHome({
      "SOUL.md": "S",
      "MEMORY.md": "m".repeat(100),
      ".config/config.json": JSON.stringify({ memory: { softBudgetTokens: 10 } }),
    });
    process.chdir(dir2);
    const prompt2 = loadSystemPrompt();
    assert.ok(prompt2.includes("exceeds the recommended budget of ~10 tokens"));
  });
});
