import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadSubagents, type SubagentConfig } from "../templates/_base/src/lib/startup.js";

// The one loader pi and codex share, so a mind's `subagents` config means the same thing on both.
describe("loadSubagents", () => {
  const scratch: string[] = [];
  afterEach(() => {
    for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function makeHome(files: Record<string, string>): string {
    const dir = mkdtempSync(resolve(tmpdir(), "subagents-"));
    scratch.push(dir);
    for (const [name, content] of Object.entries(files)) writeFileSync(resolve(dir, name), content);
    return dir;
  }

  it("loads a subagent with its prompt, tools and maxTurns", () => {
    const home = makeHome({ "helper.md": "You help." });
    const loaded = loadSubagents(
      {
        helper: {
          description: "helps",
          systemPrompt: "helper.md",
          tools: ["Read"],
          maxTurns: 3,
        },
      },
      home,
    );
    assert.deepEqual(Object.keys(loaded), ["helper"]);
    assert.equal(loaded.helper.description, "helps");
    assert.equal(loaded.helper.prompt, "You help.");
    assert.equal(loaded.helper.promptPath, resolve(home, "helper.md"));
    assert.deepEqual(loaded.helper.tools, ["Read"]);
    assert.equal(loaded.helper.maxTurns, 3);
  });

  it("returns nothing for no config", () => {
    assert.deepEqual(loadSubagents(undefined, makeHome({})), {});
  });

  it("skips entries that can't run, keeping the ones that can", () => {
    const home = makeHome({ "ok.md": "fine", "empty.md": "", "blank.md": "  \n\t\n" });
    const loaded = loadSubagents(
      {
        ok: { description: "ok", systemPrompt: "ok.md" },
        noDescription: { systemPrompt: "ok.md" } as SubagentConfig,
        noPrompt: { description: "no prompt" } as SubagentConfig,
        missing: { description: "missing", systemPrompt: "nope.md" },
        empty: { description: "empty", systemPrompt: "empty.md" },
        blank: { description: "whitespace only", systemPrompt: "blank.md" },
        nullEntry: null as unknown as SubagentConfig,
      },
      home,
    );
    assert.deepEqual(Object.keys(loaded), ["ok"]);
  });
});
