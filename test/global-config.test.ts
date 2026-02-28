import assert from "node:assert/strict";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { voluteHome } from "@volute/shared/registry";
import { readGlobalConfig } from "../src/commands/up.js";

function configPath() {
  return resolve(voluteHome(), "config.json");
}

describe("readGlobalConfig", () => {
  afterEach(() => {
    try {
      unlinkSync(configPath());
    } catch {}
  });

  it("returns empty object when config.json does not exist", () => {
    assert.deepEqual(readGlobalConfig(), {});
  });

  it("reads hostname and port from config.json", () => {
    mkdirSync(voluteHome(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ hostname: "0.0.0.0", port: 5000 }));
    const config = readGlobalConfig();
    assert.equal(config.hostname, "0.0.0.0");
    assert.equal(config.port, 5000);
  });

  it("returns partial config when only some fields are set", () => {
    mkdirSync(voluteHome(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ hostname: "0.0.0.0" }));
    const config = readGlobalConfig();
    assert.equal(config.hostname, "0.0.0.0");
    assert.equal(config.port, undefined);
  });
});
