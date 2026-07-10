import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  missingCredentialWarning,
  providerForMindTemplate,
} from "../packages/daemon/src/lib/ai-service.js";

describe("providerForMindTemplate", () => {
  it("maps templates to the provider whose key the mind needs", () => {
    assert.equal(providerForMindTemplate("claude"), "anthropic");
    assert.equal(providerForMindTemplate(undefined), "anthropic"); // default template
    assert.equal(providerForMindTemplate("codex"), "openai-codex");
    assert.equal(providerForMindTemplate("pi", "openrouter:some-model"), "openrouter");
    // pi without a determinable model → undefined (can't verify, don't warn)
    assert.equal(providerForMindTemplate("pi"), undefined);
    assert.equal(providerForMindTemplate("pi", "bare-model"), undefined);
  });
});

describe("missingCredentialWarning", () => {
  // Provider keys resolve from ambient env, so control it explicitly for determinism.
  const KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("warns, actionably, when a claude mind has no anthropic credentials", async () => {
    const warning = await missingCredentialWarning("claude", undefined, "mute-mind");
    assert.ok(warning, "expected a warning when no key is configured");
    assert.match(warning!, /anthropic/i);
    assert.match(warning!, /mute-mind/);
    assert.match(warning!, /volute env set ANTHROPIC_API_KEY/);
    assert.match(warning!, /stay silent/i);
  });

  it("does not warn once an anthropic key is present", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    const warning = await missingCredentialWarning("claude", undefined, "voiced-mind");
    assert.equal(warning, null);
  });

  it("does not warn when the provider can't be determined (pi without model)", async () => {
    const warning = await missingCredentialWarning("pi", undefined, "pi-mind");
    assert.equal(warning, null);
  });

  it("honors an ambient OPENAI_API_KEY for codex minds", async () => {
    process.env.OPENAI_API_KEY = "sk-openai-test";
    const warning = await missingCredentialWarning("codex", undefined, "codex-mind");
    assert.equal(warning, null);
  });
});
