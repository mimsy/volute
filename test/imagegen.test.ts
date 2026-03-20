import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  getConfiguredProviders,
  getEnabledModels,
  removeProviderConfig,
  resolveApiKey,
  saveProviderConfig,
  setEnabledModels,
} from "../src/lib/services/imagegen.js";
import { readGlobalConfig, writeGlobalConfig } from "../src/lib/setup.js";

function resetImagegenConfig() {
  const config = readGlobalConfig();
  delete config.imagegen;
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

    it("removes a provider config", () => {
      saveProviderConfig("replicate", "test-key");
      removeProviderConfig("replicate");
      const config = readGlobalConfig();
      assert.equal(config.imagegen?.providers, undefined);
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
  });

  describe("getEnabledModels / setEnabledModels", () => {
    it("returns empty array when no models configured", () => {
      assert.deepEqual(getEnabledModels(), []);
    });

    it("saves and retrieves enabled models", () => {
      setEnabledModels(["owner/model-a", "owner/model-b"]);
      assert.deepEqual(getEnabledModels(), ["owner/model-a", "owner/model-b"]);
    });

    it("overwrites previous models", () => {
      setEnabledModels(["owner/model-a"]);
      setEnabledModels(["owner/model-b"]);
      assert.deepEqual(getEnabledModels(), ["owner/model-b"]);
    });
  });
});
