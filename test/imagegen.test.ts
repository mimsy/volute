import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { readGlobalConfig, writeGlobalConfig } from "../packages/daemon/src/lib/config/setup.js";
import {
  getConfiguredProviders,
  getEnabledModels,
  parseModelId,
  removeProviderConfig,
  resolveApiKey,
  saveProviderConfig,
  setEnabledModels,
} from "../packages/daemon/src/lib/services/imagegen.js";

function resetImagegenConfig() {
  const config = readGlobalConfig();
  delete config.imagegen;
  delete config.ai;
  writeGlobalConfig(config);
}

describe("imagegen config", () => {
  afterEach(resetImagegenConfig);

  describe("saveProviderConfig / removeProviderConfig", () => {
    it("saves a provider API key to config", () => {
      saveProviderConfig("replicate", "test-key-123");
      const config = readGlobalConfig();
      assert.equal(config.imagegen?.providers?.replicate?.apiKey, "test-key-123");
    });

    it("saves an openrouter API key to config", () => {
      saveProviderConfig("openrouter", "or-key-456");
      const config = readGlobalConfig();
      assert.equal(config.imagegen?.providers?.openrouter?.apiKey, "or-key-456");
    });

    it("removes a provider config", () => {
      saveProviderConfig("replicate", "test-key");
      removeProviderConfig("replicate");
      const config = readGlobalConfig();
      assert.equal(config.imagegen?.providers, undefined);
    });

    it("removes openrouter config independently", () => {
      saveProviderConfig("replicate", "rep-key");
      saveProviderConfig("openrouter", "or-key");
      removeProviderConfig("openrouter");
      const config = readGlobalConfig();
      assert.equal(config.imagegen?.providers?.replicate?.apiKey, "rep-key");
      assert.equal(config.imagegen?.providers?.openrouter, undefined);
    });

    it("throws on unknown provider id", () => {
      assert.throws(
        () => saveProviderConfig("unknown-provider", "key"),
        /Unknown imagegen provider/,
      );
      assert.throws(() => removeProviderConfig("unknown-provider"), /Unknown imagegen provider/);
    });
  });

  describe("resolveApiKey", () => {
    it("returns config key when set", () => {
      saveProviderConfig("replicate", "config-key");
      assert.equal(resolveApiKey("replicate"), "config-key");
    });

    it("falls back to env var when no config key", () => {
      const original = process.env.REPLICATE_API_TOKEN;
      try {
        process.env.REPLICATE_API_TOKEN = "env-key";
        assert.equal(resolveApiKey("replicate"), "env-key");
      } finally {
        if (original !== undefined) {
          process.env.REPLICATE_API_TOKEN = original;
        } else {
          delete process.env.REPLICATE_API_TOKEN;
        }
      }
    });

    it("prefers config key over env var", () => {
      const original = process.env.REPLICATE_API_TOKEN;
      try {
        process.env.REPLICATE_API_TOKEN = "env-key";
        saveProviderConfig("replicate", "config-key");
        assert.equal(resolveApiKey("replicate"), "config-key");
      } finally {
        if (original !== undefined) {
          process.env.REPLICATE_API_TOKEN = original;
        } else {
          delete process.env.REPLICATE_API_TOKEN;
        }
      }
    });

    it("returns undefined for unknown provider", () => {
      assert.equal(resolveApiKey("nonexistent"), undefined);
    });

    it("returns undefined when nothing is configured", () => {
      const original = process.env.REPLICATE_API_TOKEN;
      try {
        delete process.env.REPLICATE_API_TOKEN;
        assert.equal(resolveApiKey("replicate"), undefined);
      } finally {
        if (original !== undefined) {
          process.env.REPLICATE_API_TOKEN = original;
        } else {
          delete process.env.REPLICATE_API_TOKEN;
        }
      }
    });

    it("resolves openrouter env var", () => {
      const original = process.env.OPENROUTER_API_KEY;
      try {
        process.env.OPENROUTER_API_KEY = "or-env-key";
        assert.equal(resolveApiKey("openrouter"), "or-env-key");
      } finally {
        if (original !== undefined) {
          process.env.OPENROUTER_API_KEY = original;
        } else {
          delete process.env.OPENROUTER_API_KEY;
        }
      }
    });

    it("falls back to AI provider config key", () => {
      const config = readGlobalConfig();
      config.ai = { providers: { openrouter: { apiKey: "ai-provider-key" } } };
      writeGlobalConfig(config);
      assert.equal(resolveApiKey("openrouter"), "ai-provider-key");
    });

    it("prefers imagegen config key over AI provider key", () => {
      const config = readGlobalConfig();
      config.ai = { providers: { openrouter: { apiKey: "ai-provider-key" } } };
      writeGlobalConfig(config);
      saveProviderConfig("openrouter", "imagegen-key");
      assert.equal(resolveApiKey("openrouter"), "imagegen-key");
    });
  });

  describe("getConfiguredProviders", () => {
    it("returns api_key auth when config key is set", () => {
      saveProviderConfig("replicate", "my-key");
      const providers = getConfiguredProviders();
      const replicate = providers.find((p) => p.id === "replicate");
      assert.ok(replicate);
      assert.equal(replicate.configured, true);
      assert.equal(replicate.authMethod, "api_key");
    });

    it("returns env_var auth when only env var is set", () => {
      const original = process.env.REPLICATE_API_TOKEN;
      try {
        process.env.REPLICATE_API_TOKEN = "env-key";
        const providers = getConfiguredProviders();
        const replicate = providers.find((p) => p.id === "replicate");
        assert.ok(replicate);
        assert.equal(replicate.configured, true);
        assert.equal(replicate.authMethod, "env_var");
      } finally {
        if (original !== undefined) {
          process.env.REPLICATE_API_TOKEN = original;
        } else {
          delete process.env.REPLICATE_API_TOKEN;
        }
      }
    });

    it("returns unconfigured when nothing is set", () => {
      const original = process.env.REPLICATE_API_TOKEN;
      try {
        delete process.env.REPLICATE_API_TOKEN;
        const providers = getConfiguredProviders();
        const replicate = providers.find((p) => p.id === "replicate");
        assert.ok(replicate);
        assert.equal(replicate.configured, false);
        assert.equal(replicate.authMethod, null);
      } finally {
        if (original !== undefined) {
          process.env.REPLICATE_API_TOKEN = original;
        } else {
          delete process.env.REPLICATE_API_TOKEN;
        }
      }
    });

    it("includes openrouter in provider list", () => {
      const providers = getConfiguredProviders();
      const openrouter = providers.find((p) => p.id === "openrouter");
      assert.ok(openrouter);
    });

    it("detects openrouter configured via AI provider config", () => {
      const config = readGlobalConfig();
      config.ai = { providers: { openrouter: { apiKey: "ai-key" } } };
      writeGlobalConfig(config);
      const providers = getConfiguredProviders();
      const openrouter = providers.find((p) => p.id === "openrouter");
      assert.ok(openrouter);
      assert.equal(openrouter.configured, true);
      assert.equal(openrouter.authMethod, "api_key");
    });
  });

  describe("getEnabledModels / setEnabledModels", () => {
    it("returns empty array when no models configured", () => {
      assert.deepEqual(getEnabledModels(), []);
    });

    it("saves and retrieves enabled models", () => {
      setEnabledModels(["replicate:owner/model-a", "openrouter:owner/model-b"]);
      assert.deepEqual(getEnabledModels(), ["replicate:owner/model-a", "openrouter:owner/model-b"]);
    });

    it("overwrites previous models", () => {
      setEnabledModels(["replicate:owner/model-a"]);
      setEnabledModels(["openrouter:owner/model-b"]);
      assert.deepEqual(getEnabledModels(), ["openrouter:owner/model-b"]);
    });
  });

  describe("parseModelId", () => {
    it("parses valid replicate model ID", () => {
      const result = parseModelId("replicate:owner/model-name");
      assert.deepEqual(result, { provider: "replicate", model: "owner/model-name" });
    });

    it("parses valid openrouter model ID", () => {
      const result = parseModelId("openrouter:openai/gpt-image-1");
      assert.deepEqual(result, { provider: "openrouter", model: "openai/gpt-image-1" });
    });

    it("throws on missing prefix", () => {
      assert.throws(() => parseModelId("owner/model-name"), /must be provider-prefixed/);
    });

    it("throws on unknown provider", () => {
      assert.throws(() => parseModelId("badprovider:owner/model"), /Unknown imagegen provider/);
    });
  });
});
