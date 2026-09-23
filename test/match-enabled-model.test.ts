import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { matchEnabledModel, setEnabledModels } from "../packages/daemon/src/lib/ai-service.js";
import {
  _resetConfigCache,
  readGlobalConfig,
  writeGlobalConfig,
} from "../packages/daemon/src/lib/config/setup.js";

/**
 * #1078: the check every named model passes before a mind is created with it —
 * the daemon's create path and the CLI's spirit-model inference share it.
 */
describe("matchEnabledModel", { concurrency: 1 }, () => {
  let saved: ReturnType<typeof readGlobalConfig>;

  beforeEach(() => {
    saved = readGlobalConfig();
    setEnabledModels(["anthropic:claude-opus-5", "openrouter:glm-4.7", "openai-codex:gpt-5.4"]);
  });

  afterEach(() => {
    writeGlobalConfig(saved);
    _resetConfigCache();
  });

  it("accepts an enabled qualified id on its template", () => {
    assert.deepEqual(matchEnabledModel("openrouter:glm-4.7", "pi"), {
      ok: true,
      model: "openrouter:glm-4.7",
    });
  });

  it("resolves a bare id to the enabled entry it names", () => {
    assert.deepEqual(matchEnabledModel("claude-opus-5", "claude"), {
      ok: true,
      model: "anthropic:claude-opus-5",
    });
  });

  it("does not prefix-match a truncated id", () => {
    const r = matchEnabledModel("claude-opus", "claude");
    assert.equal(r.ok, false);
  });

  it("lets pi run any provider's enabled model", () => {
    assert.deepEqual(matchEnabledModel("anthropic:claude-opus-5", "pi"), {
      ok: true,
      model: "anthropic:claude-opus-5",
    });
  });

  it("refuses an enabled model on another provider's template", () => {
    const r = matchEnabledModel("openrouter:glm-4.7", "claude");
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /can't run on the claude template/);
  });

  it("says so when no enabled model runs on the template", () => {
    setEnabledModels(["anthropic:claude-opus-5"]);
    const r = matchEnabledModel("gpt-5.4", "codex");
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /No enabled model runs on the codex template/);
  });
});
