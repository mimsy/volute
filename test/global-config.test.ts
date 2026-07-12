import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  _resetConfigCache,
  migrateConfigSecrets,
  secretsPath,
  writeGlobalConfig,
} from "../packages/daemon/src/lib/config/setup.js";
import { voluteSystemDir } from "../packages/daemon/src/lib/mind/registry.js";
import { readGlobalConfig } from "../src/commands/up.js";

function configPath() {
  return resolve(voluteSystemDir(), "config.json");
}

describe("readGlobalConfig", () => {
  afterEach(() => {
    _resetConfigCache();
    try {
      unlinkSync(configPath());
    } catch {}
    try {
      unlinkSync(secretsPath());
    } catch {}
  });

  it("returns empty object when config.json does not exist", () => {
    assert.deepEqual(readGlobalConfig(), {});
  });

  it("reads hostname and port from config.json", () => {
    mkdirSync(voluteSystemDir(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ hostname: "0.0.0.0", port: 5000 }));
    const config = readGlobalConfig();
    assert.equal(config.hostname, "0.0.0.0");
    assert.equal(config.port, 5000);
  });

  it("returns partial config when only some fields are set", () => {
    mkdirSync(voluteSystemDir(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ hostname: "0.0.0.0" }));
    const config = readGlobalConfig();
    assert.equal(config.hostname, "0.0.0.0");
    assert.equal(config.port, undefined);
  });

  it("writeGlobalConfig updates cache immediately", () => {
    mkdirSync(voluteSystemDir(), { recursive: true });
    writeGlobalConfig({ hostname: "first" });
    const first = readGlobalConfig();
    assert.equal(first.hostname, "first");
    writeGlobalConfig({ hostname: "second", port: 9999 });
    const second = readGlobalConfig();
    assert.equal(second.hostname, "second");
    assert.equal(second.port, 9999);
  });

  it("keeps config.json host-readable (0644) and relaxes a pre-existing 0600 file", () => {
    // config.json holds only non-secret operational state; a non-root host
    // must be able to read it on a system install.
    mkdirSync(voluteSystemDir(), { recursive: true });
    // Pre-create at 0600 (as v0.41.1 left it) to prove writeGlobalConfig relaxes perms.
    writeFileSync(configPath(), "{}", { mode: 0o600 });
    writeGlobalConfig({ hostname: "host-readable" });
    const mode = statSync(configPath()).mode & 0o777;
    assert.equal(mode, 0o644, `expected 0644, got ${mode.toString(8)}`);
  });

  it("writes provider credentials to secrets.json at owner-only (0600), not config.json", () => {
    mkdirSync(voluteSystemDir(), { recursive: true });
    writeGlobalConfig({
      hostname: "h",
      ai: { providers: { anthropic: { apiKey: "sk-secret" } }, models: ["m"] },
    });
    // The API key must not appear in the host-readable config.json.
    const configRaw = readFileSync(configPath(), "utf-8");
    assert.ok(!configRaw.includes("sk-secret"), "config.json must not contain the API key");
    assert.ok(configRaw.includes('"models"'), "non-secret ai fields stay in config.json");
    // It lives in secrets.json, locked to 0600.
    const secretsRaw = readFileSync(secretsPath(), "utf-8");
    assert.ok(secretsRaw.includes("sk-secret"));
    assert.equal(statSync(secretsPath()).mode & 0o777, 0o600);
  });

  it("round-trips provider credentials by merging secrets.json back on read", () => {
    mkdirSync(voluteSystemDir(), { recursive: true });
    writeGlobalConfig({
      ai: { providers: { openai: { apiKey: "sk-round" } }, utilityModel: "u" },
      imagegen: { providers: { fal: { apiKey: "fal-key" } }, enabled: true },
    });
    _resetConfigCache();
    const config = readGlobalConfig();
    assert.equal(config.ai?.providers.openai.apiKey, "sk-round");
    assert.equal(config.ai?.utilityModel, "u");
    assert.equal(config.imagegen?.providers?.fal.apiKey, "fal-key");
    assert.equal(config.imagegen?.enabled, true);
  });

  it("writes backup password and env to secrets.json, not config.json", () => {
    mkdirSync(voluteSystemDir(), { recursive: true });
    writeGlobalConfig({
      backup: {
        repository: "s3:s3.amazonaws.com/bucket/volute",
        schedule: "0 3 * * *",
        enabled: true,
        password: "restic-passphrase",
        env: { AWS_SECRET_ACCESS_KEY: "aws-secret" },
      },
    });
    const configRaw = readFileSync(configPath(), "utf-8");
    assert.ok(!configRaw.includes("restic-passphrase"), "config.json must not contain passphrase");
    assert.ok(!configRaw.includes("aws-secret"), "config.json must not contain credentials");
    assert.ok(configRaw.includes('"repository"'), "non-secret backup fields stay in config.json");
    const secretsRaw = readFileSync(secretsPath(), "utf-8");
    assert.ok(secretsRaw.includes("restic-passphrase"));
    assert.ok(secretsRaw.includes("aws-secret"));
    assert.equal(statSync(secretsPath()).mode & 0o777, 0o600);
    // Round-trips on read.
    _resetConfigCache();
    const config = readGlobalConfig();
    assert.equal(config.backup?.password, "restic-passphrase");
    assert.equal(config.backup?.env?.AWS_SECRET_ACCESS_KEY, "aws-secret");
    assert.equal(config.backup?.repository, "s3:s3.amazonaws.com/bucket/volute");
    assert.equal(config.backup?.enabled, true);
  });

  it("migrateConfigSecrets splits a legacy single-file config and relaxes perms", () => {
    // Simulate a v0.41.1 install: everything (incl. secrets) in a 0600 config.json.
    mkdirSync(voluteSystemDir(), { recursive: true });
    writeFileSync(
      configPath(),
      JSON.stringify({
        hostname: "legacy",
        ai: { providers: { anthropic: { apiKey: "sk-legacy" } } },
      }),
      { mode: 0o600 },
    );
    _resetConfigCache();
    migrateConfigSecrets();
    // config.json is now host-readable and stripped of secrets.
    assert.equal(statSync(configPath()).mode & 0o777, 0o644);
    assert.ok(!readFileSync(configPath(), "utf-8").includes("sk-legacy"));
    // secrets.json now holds the key at 0600.
    assert.equal(statSync(secretsPath()).mode & 0o777, 0o600);
    assert.ok(readFileSync(secretsPath(), "utf-8").includes("sk-legacy"));
    // The merged view is unchanged for callers.
    _resetConfigCache();
    assert.equal(readGlobalConfig().ai?.providers.anthropic.apiKey, "sk-legacy");
  });

  it("migrateConfigSecrets is a no-op once already split and 0644", () => {
    mkdirSync(voluteSystemDir(), { recursive: true });
    writeGlobalConfig({ hostname: "h", ai: { providers: { anthropic: { apiKey: "sk" } } } });
    const before = readFileSync(secretsPath(), "utf-8");
    _resetConfigCache();
    migrateConfigSecrets();
    assert.equal(statSync(configPath()).mode & 0o777, 0o644);
    assert.equal(readFileSync(secretsPath(), "utf-8"), before);
  });

  it("cached config is not corrupted by caller mutation", () => {
    mkdirSync(voluteSystemDir(), { recursive: true });
    writeGlobalConfig({ hostname: "original" });
    const config1 = readGlobalConfig();
    (config1 as any).hostname = "mutated";
    const config2 = readGlobalConfig();
    assert.equal(config2.hostname, "original");
  });
});
