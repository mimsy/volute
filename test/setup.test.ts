import assert from "node:assert/strict";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  type GlobalConfig,
  isSetupComplete,
  readGlobalConfig,
  writeGlobalConfig,
} from "../packages/daemon/src/lib/config/setup.js";
import { voluteSystemDir } from "../packages/daemon/src/lib/mind/registry.js";

function configPath() {
  return resolve(voluteSystemDir(), "config.json");
}

function registryPath() {
  return resolve(voluteSystemDir(), "minds.json");
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
    mkdirSync(voluteSystemDir(), { recursive: true });
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
    mkdirSync(voluteSystemDir(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ hostname: "localhost" }));
    assert.equal(isSetupComplete(), false);
  });

  it("isSetupComplete returns false when setup field exists but setupCompleted is not set", () => {
    writeGlobalConfig({
      name: "test",
      setup: { type: "local", mindsDir: "/tmp", isolation: "sandbox", service: false },
    });
    assert.equal(isSetupComplete(), false);
  });

  it("isSetupComplete returns true when setupCompleted is true", () => {
    writeGlobalConfig({
      name: "test",
      setup: { type: "local", mindsDir: "/tmp", isolation: "sandbox", service: false },
      setupCompleted: true,
    });
    assert.equal(isSetupComplete(), true);
  });
});
