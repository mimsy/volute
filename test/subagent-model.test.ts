import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { defaultSubagentModel } from "../templates/claude/src/lib/subagent-model.js";

describe("claude template subagent model", () => {
  it("defaults to sonnet", () => {
    assert.equal(defaultSubagentModel("claude-opus-4-6"), "sonnet");
    assert.equal(defaultSubagentModel("claude-fable-5"), "sonnet");
    assert.equal(defaultSubagentModel(undefined), "sonnet");
  });

  it("never raises a mind's cost: a haiku mind's subagents inherit its model", () => {
    assert.equal(defaultSubagentModel("claude-haiku-4-5"), "inherit");
    assert.equal(defaultSubagentModel("haiku"), "inherit");
  });

  // There is no seam to intercept `query()` in a unit test, so pin the source — as
  // session-env-binding.test.ts does. Each line is one path a subagent's model comes from.
  const src = readFileSync(
    resolve(import.meta.dirname, "../templates/claude/src/agent.ts"),
    "utf-8",
  );

  it("lets a mind choose a config-defined subagent's model, the dreamer included", () => {
    assert.match(src, /const subagentModel = defaultSubagentModel\(options\.model\);/);
    assert.match(src, /model: config\.model \?\? subagentModel,/);
  });

  it("covers the SDK's built-in agents, which have no model of their own", () => {
    // The CLI resolves a model-less agent definition (general-purpose) from this env var,
    // else the main loop's model. A mind's own setting of it wins.
    assert.match(
      src,
      /CLAUDE_CODE_SUBAGENT_MODEL: process\.env\.CLAUDE_CODE_SUBAGENT_MODEL \?\? subagentModel,/,
    );
  });
});
