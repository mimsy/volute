import assert from "node:assert/strict";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { voluteHome } from "../src/lib/registry.js";
import {
  type GlobalConfig,
  isSetupComplete,
  migrateSetupConfig,
  readGlobalConfig,
  writeGlobalConfig,
} from "../src/lib/setup.js";

function configPath() {
  return resolve(voluteHome(), "config.json");
}

function registryPath() {
  return resolve(voluteHome(), "minds.json");
}

function cleanup() {
  try {
    unlinkSync(configPath());
  } catch {}
  try {
    unlinkSync(registryPath());
  } catch {}
}

describe("setup config", () => {
  afterEach(cleanup);

  it("readGlobalConfig returns empty object when config.json does not exist", () => {
    assert.deepEqual(readGlobalConfig(), {});
  });

  it("readGlobalConfig reads all fields", () => {
    mkdirSync(voluteHome(), { recursive: true });
    const config: GlobalConfig = {
      name: "test",
      hostname: "0.0.0.0",
      port: 5000,
      setup: {
        type: "local",
        mindsDir: "/tmp/minds",
        isolation: "sandbox",
        service: false,
      },
    };
    writeFileSync(configPath(), JSON.stringify(config));
    const result = readGlobalConfig();
    assert.equal(result.name, "test");
    assert.equal(result.hostname, "0.0.0.0");
    assert.equal(result.port, 5000);
    assert.equal(result.setup?.type, "local");
    assert.equal(result.setup?.isolation, "sandbox");
  });

  it("writeGlobalConfig creates the file", () => {
    const config: GlobalConfig = { name: "myserver", port: 1618 };
    writeGlobalConfig(config);
    const result = readGlobalConfig();
    assert.equal(result.name, "myserver");
    assert.equal(result.port, 1618);
  });

  it("isSetupComplete returns false when no config exists", () => {
    assert.equal(isSetupComplete(), false);
  });

  it("isSetupComplete returns false when config has no setup field", () => {
    mkdirSync(voluteHome(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ hostname: "localhost" }));
    assert.equal(isSetupComplete(), false);
  });

  it("isSetupComplete returns true when setup field exists", () => {
    writeGlobalConfig({
      name: "test",
      setup: { type: "local", mindsDir: "/tmp", isolation: "sandbox", service: false },
    });
    assert.equal(isSetupComplete(), true);
  });
});

describe("migrateSetupConfig", () => {
  afterEach(cleanup);

  it("does nothing when no minds.json exists (fresh install)", () => {
    migrateSetupConfig();
    assert.equal(isSetupComplete(), false);
  });

  it("does nothing when setup is already configured", () => {
    writeGlobalConfig({
      name: "existing",
      setup: { type: "system", mindsDir: "/minds", isolation: "user", service: true },
    });
    mkdirSync(voluteHome(), { recursive: true });
    writeFileSync(registryPath(), "[]");
    migrateSetupConfig();
    // Should not overwrite existing config
    const config = readGlobalConfig();
    assert.equal(config.name, "existing");
    assert.equal(config.setup?.type, "system");
  });

  it("auto-populates setup for existing users with minds.json", () => {
    mkdirSync(voluteHome(), { recursive: true });
    writeFileSync(registryPath(), JSON.stringify([{ name: "alice", port: 4100 }]));
    migrateSetupConfig();
    const config = readGlobalConfig();
    assert.ok(config.setup);
    assert.equal(config.setup.type, "local");
    assert.equal(config.setup.isolation, "none");
  });

  it("detects system isolation from env", () => {
    const orig = process.env.VOLUTE_ISOLATION;
    process.env.VOLUTE_ISOLATION = "user";
    try {
      mkdirSync(voluteHome(), { recursive: true });
      writeFileSync(registryPath(), "[]");
      migrateSetupConfig();
      const config = readGlobalConfig();
      assert.equal(config.setup?.type, "system");
      assert.equal(config.setup?.isolation, "user");
    } finally {
      if (orig === undefined) delete process.env.VOLUTE_ISOLATION;
      else process.env.VOLUTE_ISOLATION = orig;
    }
  });
});
