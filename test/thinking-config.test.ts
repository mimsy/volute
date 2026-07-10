import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyThinkingLevel,
  deriveThinkingLevel,
} from "../packages/daemon/src/lib/mind/thinking-config.js";

describe("thinking-config", () => {
  describe("applyThinkingLevel", () => {
    it("claude: maps a level to effort and clears thinking", () => {
      const config: Record<string, unknown> = { thinking: { type: "disabled" } };
      applyThinkingLevel(config, "claude", "high");
      assert.equal(config.effort, "high");
      assert.equal("thinking" in config, false);
    });

    it("claude: folds minimal onto low (the SDK has no minimal effort)", () => {
      const config: Record<string, unknown> = {};
      applyThinkingLevel(config, "claude", "minimal");
      assert.equal(config.effort, "low");
    });

    it("claude: off disables thinking and clears effort", () => {
      const config: Record<string, unknown> = { effort: "high" };
      applyThinkingLevel(config, "claude", "off");
      assert.deepEqual(config.thinking, { type: "disabled" });
      assert.equal("effort" in config, false);
    });

    it("codex: sets reasoningEffort, off removes it", () => {
      const config: Record<string, unknown> = {};
      applyThinkingLevel(config, "codex", "xhigh");
      assert.equal(config.reasoningEffort, "xhigh");
      applyThinkingLevel(config, "codex", "off");
      assert.equal("reasoningEffort" in config, false);
    });

    it("pi: writes the unified level directly", () => {
      const config: Record<string, unknown> = {};
      applyThinkingLevel(config, "pi", "medium");
      assert.equal(config.thinkingLevel, "medium");
    });
  });

  describe("deriveThinkingLevel", () => {
    it("claude: reads effort, clamping max to xhigh", () => {
      assert.equal(deriveThinkingLevel({ effort: "medium" }), "medium");
      assert.equal(deriveThinkingLevel({ effort: "max" }), "xhigh");
    });

    it("claude: disabled thinking reads as off", () => {
      assert.equal(deriveThinkingLevel({ thinking: { type: "disabled" } }), "off");
    });

    it("codex/pi: reads their native fields", () => {
      assert.equal(deriveThinkingLevel({ reasoningEffort: "low" }), "low");
      assert.equal(deriveThinkingLevel({ thinkingLevel: "high" }), "high");
    });

    it("returns null when nothing is configured", () => {
      assert.equal(deriveThinkingLevel({}), null);
    });

    it("round-trips through apply for claude", () => {
      const config: Record<string, unknown> = {};
      applyThinkingLevel(config, "claude", "xhigh");
      assert.equal(deriveThinkingLevel(config), "xhigh");
    });
  });
});
