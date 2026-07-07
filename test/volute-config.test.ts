import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  readVoluteConfig,
  resolveWakeTriggers,
  WAKE_TRIGGER_DEFAULTS,
} from "../packages/daemon/src/lib/mind/volute-config.js";

let testDir: string;

function setup(config: Record<string, unknown>) {
  testDir = resolve(
    tmpdir(),
    `volute-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const configDir = resolve(testDir, "home/.config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(resolve(configDir, "volute.json"), JSON.stringify(config));
  return testDir;
}

describe("readVoluteConfig", () => {
  afterEach(() => {
    if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  it("reads config with profile object", () => {
    const dir = setup({
      model: "claude-sonnet-4-20250514",
      profile: { displayName: "Test", description: "A test mind", avatar: "avatar.png" },
    });
    const config = readVoluteConfig(dir);
    assert.ok(config);
    assert.equal(config.profile?.displayName, "Test");
    assert.equal(config.profile?.description, "A test mind");
    assert.equal(config.profile?.avatar, "avatar.png");
  });

  it("returns null for missing config", () => {
    const dir = resolve(tmpdir(), `volute-config-missing-${Date.now()}`);
    const config = readVoluteConfig(dir);
    assert.equal(config, null);
  });
});

describe("resolveWakeTriggers", () => {
  it("defaults mentions and DMs to on when unset", () => {
    assert.deepEqual(WAKE_TRIGGER_DEFAULTS, { mentions: true, dms: true });
    assert.deepEqual(resolveWakeTriggers(undefined), { mentions: true, dms: true });
    assert.deepEqual(resolveWakeTriggers({}), { mentions: true, dms: true });
  });

  it("respects explicit false values", () => {
    assert.deepEqual(resolveWakeTriggers({ mentions: false }), { mentions: false, dms: true });
    assert.deepEqual(resolveWakeTriggers({ dms: false }), { mentions: true, dms: false });
    assert.deepEqual(resolveWakeTriggers({ mentions: false, dms: false }), {
      mentions: false,
      dms: false,
    });
  });
});
