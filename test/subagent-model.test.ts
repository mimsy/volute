import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

// There is no seam to intercept `query()` in a unit test, so pin the source — as
// session-env-binding.test.ts does. Subagents inheriting the mind's model were a third of
// one mind's real spend; each line below is one of the paths a subagent's model comes from.
describe("claude template subagent model", () => {
  const src = readFileSync(
    resolve(import.meta.dirname, "../templates/claude/src/agent.ts"),
    "utf-8",
  );

  it("defaults to sonnet", () => {
    assert.match(src, /const SUBAGENT_MODEL = "sonnet";/);
  });

  it("lets a mind choose a config-defined subagent's model, the dreamer included", () => {
    assert.match(src, /model: config\.model \?\? SUBAGENT_MODEL,/);
  });

  it("covers the SDK's built-in agents, which have no model of their own", () => {
    // The CLI resolves a model-less agent definition (general-purpose) from this env var,
    // else the main loop's model. A mind's own setting of it wins.
    assert.match(
      src,
      /CLAUDE_CODE_SUBAGENT_MODEL: process\.env\.CLAUDE_CODE_SUBAGENT_MODEL \?\? SUBAGENT_MODEL,/,
    );
  });
});
