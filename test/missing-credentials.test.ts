import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  missingCredentialWarning,
  providerForMindTemplate,
} from "../packages/daemon/src/lib/ai-service.js";
import { mindEnvPath, writeEnv } from "../packages/daemon/src/lib/config/env.js";
import { drainNotices } from "../packages/daemon/src/lib/daemon/notices.js";

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

// Provider keys resolve from ambient env, so control it explicitly for determinism.
const KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];
let saved: Record<string, string | undefined>;

function stashKeys() {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
}

function restoreKeys() {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

describe("missingCredentialWarning", () => {
  beforeEach(stashKeys);
  afterEach(restoreKeys);

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

  it("names the pi provider's env var in the warning", async () => {
    const warning = await missingCredentialWarning("pi", "openrouter:some-model", "pi-mind");
    assert.ok(warning);
    assert.match(warning!, /openrouter/i);
    assert.match(warning!, /volute env set OPENROUTER_API_KEY/);
  });

  it("honors an ambient OPENAI_API_KEY for codex minds", async () => {
    process.env.OPENAI_API_KEY = "sk-openai-test";
    const warning = await missingCredentialWarning("codex", undefined, "codex-mind");
    assert.equal(warning, null);
  });

  it("honors a key set in the mind's env.json — the warning's own remediation", async () => {
    const mind = `envjson-mind-${process.pid}`;
    writeEnv(mindEnvPath(mind), { ANTHROPIC_API_KEY: "sk-ant-from-env-json" });
    try {
      const warning = await missingCredentialWarning("claude", undefined, mind);
      assert.equal(warning, null);
    } finally {
      rmSync(mindEnvPath(mind), { force: true });
    }
  });
});

describe("recordMissingCredentialsNotice", () => {
  beforeEach(stashKeys);
  afterEach(restoreKeys);

  it("records exactly one deduped no_credentials notice for a keyless claude mind", async () => {
    const { recordMissingCredentialsNotice } = await import(
      "../packages/daemon/src/lib/daemon/mind-service.js"
    );
    const mind = `nocreds-claude-${process.pid}-${Date.now()}`;
    await recordMissingCredentialsNotice(mind, "claude");
    await recordMissingCredentialsNotice(mind, "claude"); // dedup: no second notice
    const notices = await drainNotices(mind, "main");
    assert.equal(notices.length, 1);
    assert.equal(notices[0].kind, "startup");
    assert.equal(notices[0].reason, "no_credentials");
    assert.match(notices[0].detail, /stay silent/i);
  });

  it("reads a pi mind's model from its SDK config to resolve the provider", async () => {
    const { recordMissingCredentialsNotice } = await import(
      "../packages/daemon/src/lib/daemon/mind-service.js"
    );
    const { mindDir } = await import("../packages/daemon/src/lib/mind/registry.js");
    const mind = `nocreds-pi-${process.pid}-${Date.now()}`;
    const configDir = resolve(mindDir(mind), "home/.config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      resolve(configDir, "config.json"),
      JSON.stringify({ model: "openrouter:some-model" }),
    );
    try {
      await recordMissingCredentialsNotice(mind, "pi");
      const notices = await drainNotices(mind, "main");
      assert.equal(notices.length, 1);
      assert.equal(notices[0].reason, "no_credentials");
      assert.match(notices[0].detail, /OPENROUTER_API_KEY/);
    } finally {
      rmSync(mindDir(mind), { recursive: true, force: true });
    }
  });

  it("records nothing for a pi mind whose model can't be determined", async () => {
    const { recordMissingCredentialsNotice } = await import(
      "../packages/daemon/src/lib/daemon/mind-service.js"
    );
    const mind = `nocreds-pi-nomodel-${process.pid}-${Date.now()}`;
    await recordMissingCredentialsNotice(mind, "pi");
    const notices = await drainNotices(mind, "main");
    assert.equal(notices.length, 0);
  });
});
