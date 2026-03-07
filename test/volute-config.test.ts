import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { readVoluteConfig } from "../src/lib/volute-config.js";

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

  it("migrates legacy top-level profile fields into profile object", () => {
    const dir = setup({
      model: "claude-sonnet-4-20250514",
      displayName: "Legacy Name",
      description: "legacy desc",
      avatar: "old-avatar.png",
    });
    const config = readVoluteConfig(dir);
    assert.ok(config);
    assert.equal(config.profile?.displayName, "Legacy Name");
    assert.equal(config.profile?.description, "legacy desc");
    assert.equal(config.profile?.avatar, "old-avatar.png");
    // Legacy fields should be removed
    assert.equal("displayName" in config, false);
    assert.equal("description" in config, false);
    assert.equal("avatar" in config, false);
  });

  it("does not migrate if profile already exists", () => {
    const dir = setup({
      profile: { displayName: "New" },
      displayName: "Old",
    });
    const config = readVoluteConfig(dir);
    assert.ok(config);
    assert.equal(config.profile?.displayName, "New");
  });

  it("returns null for missing config", () => {
    const dir = resolve(tmpdir(), `volute-config-missing-${Date.now()}`);
    const config = readVoluteConfig(dir);
    assert.equal(config, null);
  });
});
