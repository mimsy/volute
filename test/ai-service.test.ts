import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getAiConfig,
  removeAiConfig,
  removeProviderConfig,
  saveProviderConfig,
} from "../packages/daemon/src/lib/ai-service.js";

describe("ai-service config", () => {
  it("returns null when not configured", () => {
    removeAiConfig(); // Ensure clean state
    assert.equal(getAiConfig(), null);
  });

  it("saves and reads provider config", () => {
    saveProviderConfig("anthropic", { apiKey: "sk-test" });
    const config = getAiConfig();
    assert.ok(config);
    assert.equal(config.providers.anthropic?.apiKey, "sk-test");
  });

  it("saves multiple providers", () => {
    saveProviderConfig("anthropic", { apiKey: "sk-ant" });
    saveProviderConfig("openai", { apiKey: "sk-oai" });
    const config = getAiConfig();
    assert.ok(config);
    assert.equal(config.providers.anthropic?.apiKey, "sk-ant");
    assert.equal(config.providers.openai?.apiKey, "sk-oai");
  });

  it("removes a single provider", () => {
    saveProviderConfig("anthropic", { apiKey: "sk-ant" });
    saveProviderConfig("openai", { apiKey: "sk-oai" });
    removeProviderConfig("anthropic");
    const config = getAiConfig();
    assert.ok(config);
    assert.equal(config.providers.anthropic, undefined);
    assert.equal(config.providers.openai?.apiKey, "sk-oai");
  });

  it("removes all config", () => {
    saveProviderConfig("anthropic", { apiKey: "sk-test" });
    removeAiConfig();
    assert.equal(getAiConfig(), null);
  });

  it("cleans up ai key when last provider removed", () => {
    saveProviderConfig("anthropic", { apiKey: "sk-test" });
    removeProviderConfig("anthropic");
    assert.equal(getAiConfig(), null);
  });
});
