import assert from "node:assert/strict";
import { mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { _resetConfigCache, writeGlobalConfig } from "../packages/daemon/src/lib/config/setup.js";
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

  it("writeGlobalConfig locks config.json to owner-only (0600)", () => {
    // config.json holds provider API keys and OAuth refresh tokens.
    mkdirSync(voluteSystemDir(), { recursive: true });
    // Pre-create with loose perms to prove writeGlobalConfig tightens them.
    writeFileSync(configPath(), "{}", { mode: 0o644 });
    writeGlobalConfig({ hostname: "secret-holder" });
    const mode = statSync(configPath()).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
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
