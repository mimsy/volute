import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
  boundLogText,
  consolidateMemory,
  MAX_CONSOLIDATION_INPUT_CHARS,
  readDailyLogs,
} from "../packages/daemon/src/lib/mind/consolidate.js";

function makeMind(logs: Record<string, string>, soul = "You are Test.\n"): string {
  const dir = mkdtempSync(resolve(tmpdir(), "consolidate-test-"));
  const home = resolve(dir, "home");
  const memory = resolve(home, "memory");
  mkdirSync(memory, { recursive: true });
  writeFileSync(resolve(home, "SOUL.md"), soul);
  for (const [name, content] of Object.entries(logs)) {
    writeFileSync(resolve(memory, name), content);
  }
  return dir;
}

describe("readDailyLogs", () => {
  it("reads dated logs oldest-first, skipping empties and non-dated files", () => {
    const dir = makeMind({
      "2026-01-02.md": "second",
      "2026-01-01.md": "first",
      "2026-01-03.md": "   ", // whitespace only → skipped
      "notes.md": "not a daily log", // wrong name → skipped
    });
    const logs = readDailyLogs(resolve(dir, "home/memory"));
    assert.deepEqual(logs, ["### 2026-01-01\n\nfirst", "### 2026-01-02\n\nsecond"]);
  });

  it("returns an empty array when the memory dir is missing", () => {
    assert.deepEqual(readDailyLogs(resolve(tmpdir(), "does-not-exist-xyz")), []);
  });
});

describe("boundLogText", () => {
  it("returns all logs joined when under the budget", () => {
    assert.equal(boundLogText(["a", "b", "c"], 1000), "a\n\nb\n\nc");
  });

  it("drops the oldest logs when over budget, keeping the most recent", () => {
    // Each log is 10 chars; budget of 25 fits two (10 + 2 + 10 = 22).
    const logs = ["0000000000", "1111111111", "2222222222"];
    const out = boundLogText(logs, 25);
    assert.equal(out, "1111111111\n\n2222222222");
    assert.ok(out.length <= 25);
  });

  it("truncates a single oversized log to the budget (tail kept)", () => {
    const big = `${"x".repeat(500)}END`;
    const out = boundLogText([big], 100);
    assert.equal(out.length, 100);
    assert.ok(out.endsWith("END"));
  });
});

describe("consolidateMemory", () => {
  it("skips (and never calls the model) when there are no logs", async () => {
    const dir = makeMind({});
    let called = false;
    await consolidateMemory(dir, async () => {
      called = true;
      return "should not run";
    });
    assert.equal(called, false);
    assert.equal(existsSync(resolve(dir, "home/MEMORY.md")), false);
  });

  it("passes SOUL.md as the system prompt and writes returned content to MEMORY.md", async () => {
    const dir = makeMind({ "2026-01-01.md": "did a thing" }, "You are Soulful.\n");
    let seenSystem: string | undefined;
    let seenUser: string | undefined;
    await consolidateMemory(dir, async (system, user) => {
      seenSystem = system;
      seenUser = user;
      return "# Memory\n\nConsolidated.";
    });
    assert.equal(seenSystem, "You are Soulful.\n");
    assert.ok(seenUser?.includes("did a thing"));
    assert.equal(
      readFileSync(resolve(dir, "home/MEMORY.md"), "utf-8"),
      "# Memory\n\nConsolidated.\n",
    );
  });

  it("does not write MEMORY.md when the model returns null (e.g. no model configured)", async () => {
    const dir = makeMind({ "2026-01-01.md": "did a thing" });
    await consolidateMemory(dir, async () => null);
    assert.equal(existsSync(resolve(dir, "home/MEMORY.md")), false);
  });

  it("bounds the log text handed to the model", async () => {
    // 20 logs of ~50k chars each = ~1M chars, far over the bound.
    const logs: Record<string, string> = {};
    for (let i = 0; i < 20; i++) {
      const day = String(i + 1).padStart(2, "0");
      logs[`2026-01-${day}.md`] = "z".repeat(50_000);
    }
    const dir = makeMind(logs);
    let seenUser = "";
    await consolidateMemory(dir, async (_system, user) => {
      seenUser = user;
      return "ok";
    });
    // Instruction preamble is small; the whole message stays near the bound.
    assert.ok(seenUser.length <= MAX_CONSOLIDATION_INPUT_CHARS + 500);
  });
});
