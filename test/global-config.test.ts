import assert from "node:assert/strict";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
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

  it("cached config is not corrupted by caller mutation", () => {
    mkdirSync(voluteSystemDir(), { recursive: true });
    writeGlobalConfig({ hostname: "original" });
    const config1 = readGlobalConfig();
    (config1 as any).hostname = "mutated";
    const config2 = readGlobalConfig();
    assert.equal(config2.hostname, "original");
  });
});
