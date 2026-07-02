import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import {
  addCustomModel,
  buildCustomModel,
  getAiConfig,
  getAvailableModels,
  getCustomModels,
  getEnabledModels,
  qualifyModelId,
  removeAiConfig,
  removeCustomModel,
  removeProviderConfig,
  saveProviderConfig,
  setEnabledModels,
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

describe("custom models", () => {
  it("buildCustomModel clones a sibling: correct api, nonzero caps, zeroed cost", () => {
    const model = buildCustomModel("anthropic", "claude-future-1");
    assert.ok(model);
    assert.equal(model.id, "claude-future-1");
    assert.equal(model.name, "claude-future-1");
    assert.equal(model.provider, "anthropic");
    assert.equal(model.api, "anthropic-messages");
    assert.ok(model.maxTokens > 0);
    assert.ok(model.contextWindow > 0);
    assert.equal(model.cost.input, 0);
    assert.equal(model.cost.output, 0);
  });

  it("buildCustomModel prefers the family (longest-prefix) sibling", () => {
    const opus = getBuiltinModels("anthropic").find((m) => m.id.includes("opus"));
    assert.ok(opus, "expected an anthropic opus model in the catalog");
    // Sharing opus's full id as a prefix guarantees it's the longest-prefix sibling.
    const model = buildCustomModel("anthropic", `${opus.id}-next`);
    assert.ok(model);
    assert.equal(model.contextWindow, opus.contextWindow);
  });

  it("buildCustomModel falls back to the largest-context sibling when no family overlaps", () => {
    const maxCtx = Math.max(...getBuiltinModels("anthropic").map((m) => m.contextWindow));
    const model = buildCustomModel("anthropic", "zzz-no-overlap");
    assert.ok(model);
    assert.equal(model.contextWindow, maxCtx);
  });

  it("buildCustomModel returns undefined for a provider with no built-in models", () => {
    assert.equal(buildCustomModel("not-a-real-provider", "whatever"), undefined);
  });

  it("getAvailableModels includes custom models for configured providers", async () => {
    removeAiConfig();
    saveProviderConfig("anthropic", { apiKey: "sk-test" });
    addCustomModel("anthropic", "claude-future-2");
    const models = await getAvailableModels();
    const found = models.find((m) => m.id === "claude-future-2");
    assert.ok(found);
    assert.equal(found.provider, "anthropic");
  });

  it("addCustomModel dedupes", () => {
    removeAiConfig();
    saveProviderConfig("anthropic", { apiKey: "sk-test" });
    addCustomModel("anthropic", "claude-future-3");
    addCustomModel("anthropic", "claude-future-3");
    assert.equal(getCustomModels().filter((m) => m.id === "claude-future-3").length, 1);
  });

  it("removeCustomModel drops the record and the enabled id", () => {
    removeAiConfig();
    saveProviderConfig("anthropic", { apiKey: "sk-test" });
    addCustomModel("anthropic", "claude-future-4");
    setEnabledModels(["claude-future-4"]);
    removeCustomModel("anthropic", "claude-future-4");
    assert.equal(getCustomModels().length, 0);
    assert.equal(getEnabledModels().includes("claude-future-4"), false);
  });

  it("built-in wins: getAvailableModels dedupes and prunes an absorbed custom id", async () => {
    removeAiConfig();
    saveProviderConfig("anthropic", { apiKey: "sk-test" });
    const builtinId = getBuiltinModels("anthropic")[0].id;
    addCustomModel("anthropic", builtinId);
    const models = await getAvailableModels();
    assert.equal(models.filter((m) => m.id === builtinId).length, 1);
    // The custom record is pruned once the catalog covers the id.
    assert.equal(getCustomModels().length, 0);
  });

  it("buildCustomModel uses an explicit display name when given", () => {
    const model = buildCustomModel("anthropic", "claude-future-x", "Friendly Name");
    assert.ok(model);
    assert.equal(model.name, "Friendly Name");
    assert.equal(model.id, "claude-future-x");
  });

  it("addCustomModel persists an explicit name", () => {
    removeAiConfig();
    saveProviderConfig("anthropic", { apiKey: "sk-test" });
    addCustomModel("anthropic", "claude-future-named", "My Model");
    const rec = getCustomModels().find((m) => m.id === "claude-future-named");
    assert.equal(rec?.name, "My Model");
  });

  it("qualifyModelId resolves a custom id to its provider (findModel custom path)", () => {
    removeAiConfig();
    saveProviderConfig("anthropic", { apiKey: "sk-test" });
    addCustomModel("anthropic", "claude-future-q");
    assert.equal(qualifyModelId("claude-future-q"), "anthropic:claude-future-q");
  });

  it("qualifyModelId still resolves a built-in id (built-in wins in findModel)", () => {
    removeAiConfig();
    saveProviderConfig("anthropic", { apiKey: "sk-test" });
    const builtin = getBuiltinModels("anthropic")[0];
    assert.equal(qualifyModelId(builtin.id), `anthropic:${builtin.id}`);
  });

  it("removeCustomModel deletes only the target, leaving siblings intact", () => {
    removeAiConfig();
    saveProviderConfig("anthropic", { apiKey: "sk-test" });
    addCustomModel("anthropic", "keep-me");
    addCustomModel("anthropic", "delete-me");
    setEnabledModels(["keep-me", "delete-me"]);
    removeCustomModel("anthropic", "delete-me");
    assert.deepEqual(
      getCustomModels().map((m) => m.id),
      ["keep-me"],
    );
    assert.deepEqual(getEnabledModels(), ["keep-me"]);
  });
});
