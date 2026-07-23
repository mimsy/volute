import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import {
  addCustomModel,
  buildCustomModel,
  findModel,
  getAiConfig,
  getAvailableModels,
  getCustomModels,
  getEnabledModels,
  missingCredentialWarning,
  OAuthRefreshError,
  qualifyModelId,
  removeAiConfig,
  removeCustomModel,
  removeProviderConfig,
  resolveApiKey,
  resolveOAuthCredentials,
  saveProviderConfig,
  setEnabledModels,
  unqualifyModelId,
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

describe("resolveOAuthCredentials", () => {
  it("returns undefined when the provider has no stored oauth", async () => {
    removeAiConfig();
    saveProviderConfig("github-copilot", { apiKey: "static-key" });
    assert.equal(await resolveOAuthCredentials("github-copilot"), undefined);
  });

  it("returns the stored credential unchanged when it isn't expired (no refresh/network call)", async () => {
    removeAiConfig();
    const oauth = {
      access: "copilot-session-token",
      refresh: "gh-oauth-refresh",
      expires: 4102444800000, // year 2100 — never expired during a test run
    };
    saveProviderConfig("github-copilot", { oauth });
    const result = await resolveOAuthCredentials("github-copilot");
    assert.deepEqual(result, oauth);
  });

  it("throws OAuthRefreshError (not undefined) when OAuth is configured but refresh fails", async () => {
    // A subscription-only provider losing its only credential path to a transient
    // auth-server blip must NOT collapse into undefined (which reads as "not
    // configured"). expires:0 forces a refresh; the failing fetch makes it throw.
    removeAiConfig();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError("token endpoint unreachable");
    }) as typeof fetch;
    try {
      saveProviderConfig("github-copilot", {
        oauth: { access: "expired", refresh: "r", expires: 0 },
      });
      await assert.rejects(resolveOAuthCredentials("github-copilot"), (err: unknown) => {
        assert.ok(err instanceof OAuthRefreshError, "should be an OAuthRefreshError");
        assert.equal(err.providerId, "github-copilot");
        // Must dodge BOTH of the skill's fallback-classifier regexes, or a future
        // reword could resurrect #701 while still passing this test.
        assert.doesNotMatch(err.message, /not configured/i);
        assert.doesNotMatch(err.message, /No .* API key/i);
        return true;
      });
    } finally {
      globalThis.fetch = realFetch;
      removeAiConfig();
    }
  });
});

describe("resolveApiKey", () => {
  it("falls back to a configured API key when OAuth refresh fails (never throws)", async () => {
    removeAiConfig();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError("token endpoint unreachable");
    }) as typeof fetch;
    try {
      saveProviderConfig("github-copilot", {
        oauth: { access: "expired", refresh: "r", expires: 0 },
        apiKey: "static-fallback-key",
      });
      assert.equal(await resolveApiKey("github-copilot"), "static-fallback-key");
    } finally {
      globalThis.fetch = realFetch;
      removeAiConfig();
    }
  });

  it("returns undefined (not throws) when OAuth refresh fails and no key fallback exists", async () => {
    removeAiConfig();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError("token endpoint unreachable");
    }) as typeof fetch;
    try {
      saveProviderConfig("github-copilot", {
        oauth: { access: "expired", refresh: "r", expires: 0 },
      });
      assert.equal(await resolveApiKey("github-copilot"), undefined);
    } finally {
      globalThis.fetch = realFetch;
      removeAiConfig();
    }
  });
});

describe("missingCredentialWarning", () => {
  it("warns transiently (never 'not configured' / 'volute env set') when OAuth refresh is failing", async () => {
    // A configured-but-transiently-failing OAuth provider must not be reported as
    // unconfigured with remediation advice for a provider that IS configured (#701).
    removeAiConfig();
    const realFetch = globalThis.fetch;
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    globalThis.fetch = (async () => {
      throw new TypeError("token endpoint unreachable");
    }) as typeof fetch;
    try {
      saveProviderConfig("anthropic", { oauth: { access: "expired", refresh: "r", expires: 0 } });
      const warning = await missingCredentialWarning("claude", undefined, "test-mind-transient");
      assert.ok(warning, "should return a warning");
      assert.match(warning, /temporarily unavailable/i);
      assert.doesNotMatch(warning, /not configured/i);
      assert.doesNotMatch(warning, /volute env set/i);
    } finally {
      globalThis.fetch = realFetch;
      if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
      else delete process.env.ANTHROPIC_API_KEY;
      removeAiConfig();
    }
  });

  it("still says 'not configured' with remediation when nothing is configured", async () => {
    removeAiConfig();
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const warning = await missingCredentialWarning("claude", undefined, "test-mind-unconfigured");
      assert.ok(warning);
      assert.match(warning, /No anthropic credentials are configured/);
      assert.match(warning, /volute env set/);
    } finally {
      if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
      else delete process.env.ANTHROPIC_API_KEY;
      removeAiConfig();
    }
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
    setEnabledModels(["anthropic:claude-future-4"]);
    removeCustomModel("anthropic", "claude-future-4");
    assert.equal(getCustomModels().length, 0);
    assert.equal(getEnabledModels().includes("anthropic:claude-future-4"), false);
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
    setEnabledModels(["anthropic:keep-me", "anthropic:delete-me"]);
    removeCustomModel("anthropic", "delete-me");
    assert.deepEqual(
      getCustomModels().map((m) => m.id),
      ["keep-me"],
    );
    assert.deepEqual(getEnabledModels(), ["anthropic:keep-me"]);
  });
});

describe("findModel provider-qualified resolution", () => {
  it("resolves a provider:model id within that provider only", () => {
    removeAiConfig();
    // gpt-5.5 is served by several providers; the prefix disambiguates.
    const codex = findModel("openai-codex:gpt-5.5");
    assert.ok(codex, "expected openai-codex:gpt-5.5 to resolve");
    assert.equal(codex.provider, "openai-codex");

    const copilot = findModel("github-copilot:gpt-5.5");
    assert.ok(copilot, "expected github-copilot:gpt-5.5 to resolve");
    assert.equal(copilot.provider, "github-copilot");
  });

  it("returns undefined when the provider does not serve the model", () => {
    removeAiConfig();
    assert.equal(findModel("anthropic:gpt-5.5"), undefined);
  });

  it("resolves a provider:model custom id within that provider", () => {
    removeAiConfig();
    saveProviderConfig("anthropic", { apiKey: "sk-test" });
    addCustomModel("anthropic", "claude-future-pq");
    const found = findModel("anthropic:claude-future-pq");
    assert.ok(found);
    assert.equal(found.provider, "anthropic");
    // Wrong provider prefix must not resolve the custom model.
    assert.equal(findModel("openai:claude-future-pq"), undefined);
  });

  it("still resolves a bare built-in id (legacy fallback)", () => {
    removeAiConfig();
    const builtin = getBuiltinModels("anthropic")[0];
    const found = findModel(builtin.id);
    assert.ok(found);
    assert.equal(found.id, builtin.id);
  });
});

describe("spirit config.model derivation from a qualified spiritModel", () => {
  // syncSpiritTemplate writes `template === "pi" ? qualifyModelId(m) : unqualifyModelId(m)`.
  // With a provider-qualified spiritModel, pi keeps the qualified form and codex/claude
  // get a bare slug — this covers that branch without a full sync harness.
  it("pi keeps the qualified id; codex/claude get the bare slug", () => {
    const qualified = "openai-codex:gpt-5.5";
    assert.equal(qualifyModelId(qualified), "openai-codex:gpt-5.5");
    assert.equal(unqualifyModelId(qualified), "gpt-5.5");
  });
});
