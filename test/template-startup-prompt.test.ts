import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
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
      writeFileSync(resolve(dir, "home", name), content);
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

  it("is unchanged for minds without SPIRIT.md", () => {
    const dir = makeHome({ "SOUL.md": "SOUL-CONTENT", "VOLUTE.md": "V", "MEMORY.md": "M" });
    process.chdir(dir);
    const prompt = loadSystemPrompt();
    assert.equal(prompt, "SOUL-CONTENT\n\n---\n\nV\n\n---\n\n## Memory\n\nM");
  });
});
