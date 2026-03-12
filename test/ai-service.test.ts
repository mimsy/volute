import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getAiConfig,
  isAiConfigured,
  removeAiConfig,
  saveAiConfig,
} from "../src/lib/ai-service.js";

describe("ai-service config", () => {
  it("returns null when not configured", () => {
    assert.equal(getAiConfig(), null);
    assert.equal(isAiConfigured(), false);
  });

  it("saves and reads config", () => {
    saveAiConfig({ provider: "anthropic", model: "claude-haiku-4-5-20251001" });
    const config = getAiConfig();
    assert.equal(config?.provider, "anthropic");
    assert.equal(config?.model, "claude-haiku-4-5-20251001");
    assert.equal(isAiConfigured(), true);
  });

  it("saves config with API key", () => {
    saveAiConfig({ provider: "openai", model: "gpt-4o-mini", apiKey: "sk-test" });
    const config = getAiConfig();
    assert.equal(config?.provider, "openai");
    assert.equal(config?.apiKey, "sk-test");
  });

  it("removes config", () => {
    saveAiConfig({ provider: "anthropic", model: "claude-haiku-4-5-20251001" });
    assert.equal(isAiConfigured(), true);
    removeAiConfig();
    assert.equal(isAiConfigured(), false);
    assert.equal(getAiConfig(), null);
  });
});
