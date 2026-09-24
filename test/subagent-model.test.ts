import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { defaultSubagentModel } from "../templates/claude/src/lib/subagent-model.js";

describe("claude template subagent model", () => {
  it("defaults an opus- or fable-class mind's subagents to sonnet", () => {
    assert.equal(defaultSubagentModel("claude-opus-4-6"), "sonnet");
    assert.equal(defaultSubagentModel("claude-opus-4-6[1m]"), "sonnet");
    assert.equal(defaultSubagentModel("opus"), "sonnet");
    assert.equal(defaultSubagentModel("claude-fable-5"), "sonnet");
  });

  it("inherits everywhere else: never a cost rise, a family switch, or a model the backend may lack", () => {
    assert.equal(defaultSubagentModel("claude-haiku-4-5"), "inherit");
    assert.equal(defaultSubagentModel("claude-sonnet-4-5"), "inherit");
    assert.equal(defaultSubagentModel("us.anthropic.claude-sonnet-4-5-v1:0"), "inherit");
    assert.equal(defaultSubagentModel("moonshotai/kimi-k2.5"), "inherit");
    assert.equal(defaultSubagentModel(undefined), "inherit");
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
    // Set only for a non-inherit default: absent is the CLI's own "inherit".
    assert.match(
      src,
      /\.\.\.\(subagentModel !== "inherit" &&\s*!process\.env\.CLAUDE_CODE_SUBAGENT_MODEL && \{ CLAUDE_CODE_SUBAGENT_MODEL: subagentModel \}\)/,
    );
  });
});
