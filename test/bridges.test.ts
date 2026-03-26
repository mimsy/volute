import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

// We need to set VOLUTE_HOME before importing bridges.ts (which uses voluteSystemDir)
const testHome = process.env.VOLUTE_HOME!;

import {
  findBridgeForChannel,
  getBridgeConfig,
  readBridgesConfig,
  removeBridgeConfig,
  removeChannelMapping,
  resolveChannelMapping,
  setBridgeConfig,
  setChannelMapping,
  writeBridgesConfig,
} from "../packages/daemon/src/lib/bridges/bridges.js";

describe("bridges config", () => {
  const bridgesPath = resolve(testHome, "system", "bridges.json");

  beforeEach(() => {
    // Clean up before each test
    if (existsSync(bridgesPath)) rmSync(bridgesPath);
  });

  afterEach(() => {
    if (existsSync(bridgesPath)) rmSync(bridgesPath);
  });

  it("readBridgesConfig returns empty object when no file", () => {
    const config = readBridgesConfig();
    assert.deepEqual(config, {});
  });

  it("writeBridgesConfig and readBridgesConfig round-trip", () => {
    const config = {
      discord: {
        enabled: true,
        defaultMind: "luna",
        channelMappings: { "my-server/general": "general" },
      },
    };
    writeBridgesConfig(config);
    const read = readBridgesConfig();
    assert.deepEqual(read, config);
  });

  it("getBridgeConfig returns null for unconfigured platform", () => {
    assert.equal(getBridgeConfig("discord"), null);
  });

  it("setBridgeConfig and getBridgeConfig", () => {
    setBridgeConfig("discord", {
      enabled: true,
      defaultMind: "luna",
      channelMappings: {},
    });
    const config = getBridgeConfig("discord");
    assert.ok(config);
    assert.equal(config!.enabled, true);
    assert.equal(config!.defaultMind, "luna");
  });

  it("removeBridgeConfig removes platform", () => {
    setBridgeConfig("discord", {
      enabled: true,
      defaultMind: "luna",
      channelMappings: {},
    });
    removeBridgeConfig("discord");
    assert.equal(getBridgeConfig("discord"), null);
  });

  it("setChannelMapping adds mapping", () => {
    setBridgeConfig("discord", {
      enabled: true,
      defaultMind: "luna",
      channelMappings: {},
    });
    setChannelMapping("discord", "my-server/general", "general");
    const config = getBridgeConfig("discord");
    assert.equal(config!.channelMappings["my-server/general"], "general");
  });

  it("setChannelMapping throws for unconfigured platform", () => {
    assert.throws(() => setChannelMapping("discord", "ch", "gen"), /not configured/);
  });

  it("removeChannelMapping removes mapping", () => {
    setBridgeConfig("discord", {
      enabled: true,
      defaultMind: "luna",
      channelMappings: { "my-server/general": "general" },
    });
    removeChannelMapping("discord", "my-server/general");
    const config = getBridgeConfig("discord");
    assert.deepEqual(config!.channelMappings, {});
  });

  it("resolveChannelMapping returns mapped channel", () => {
    setBridgeConfig("discord", {
      enabled: true,
      defaultMind: "luna",
      channelMappings: { "my-server/general": "general" },
    });
    assert.equal(resolveChannelMapping("discord", "my-server/general"), "general");
    assert.equal(resolveChannelMapping("discord", "unknown"), null);
  });

  it("findBridgeForChannel finds bridge for a volute channel name", () => {
    setBridgeConfig("discord", {
      enabled: true,
      defaultMind: "luna",
      channelMappings: { "my-server/general": "general" },
    });
    const result = findBridgeForChannel("general");
    assert.ok(result);
    assert.equal(result!.platform, "discord");
    assert.equal(result!.externalChannel, "my-server/general");
  });

  it("findBridgeForChannel returns null for unbridged channel", () => {
    setBridgeConfig("discord", {
      enabled: true,
      defaultMind: "luna",
      channelMappings: { "my-server/general": "general" },
    });
    assert.equal(findBridgeForChannel("random"), null);
  });

  it("findBridgeForChannel skips disabled bridges", () => {
    setBridgeConfig("discord", {
      enabled: false,
      defaultMind: "luna",
      channelMappings: { "my-server/general": "general" },
    });
    assert.equal(findBridgeForChannel("general"), null);
  });
});
