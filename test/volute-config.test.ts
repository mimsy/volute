import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { addMind, addVariant, removeMind } from "../packages/daemon/src/lib/mind/registry.js";
import {
  chownVoluteConfigPaths,
  readVoluteConfig,
  resolveWakeTriggers,
  WAKE_TRIGGER_DEFAULTS,
  writeVoluteConfig,
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

// #1072: a daemon-side write that creates volute.json (or its dir) leaves it owned
// by the daemon — root under user isolation — so the mind can't edit its own config.
// writeVoluteConfig reports what it created so exactly those paths get handed over.
describe("writeVoluteConfig ownership handoff", () => {
  let dir: string;
  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true });
  });
  function freshDir(): string {
    dir = resolve(
      tmpdir(),
      `volute-config-own-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    return dir;
  }

  it("reports home/, .config/ and the file when it created all three", () => {
    const d = freshDir();
    mkdirSync(d);
    assert.deepEqual(writeVoluteConfig(d, {}), [
      resolve(d, "home"),
      resolve(d, "home/.config"),
      resolve(d, "home/.config/volute.json"),
    ]);
  });

  it("reports only the file when the dir already exists", () => {
    const d = freshDir();
    mkdirSync(resolve(d, "home/.config"), { recursive: true });
    assert.deepEqual(writeVoluteConfig(d, {}), [resolve(d, "home/.config/volute.json")]);
  });

  it("reports nothing on a rewrite, and truncates in place (keeping the mind's inode)", () => {
    const d = freshDir();
    const path = resolve(d, "home/.config/volute.json");
    writeVoluteConfig(d, { model: "a" });
    const inode = statSync(path).ino;
    assert.deepEqual(writeVoluteConfig(d, { model: "b" }), []);
    assert.equal(statSync(path).ino, inode);
    assert.equal(readVoluteConfig(d)?.model, "b");
  });

  it("refuses to write through a symlink planted at volute.json", () => {
    const d = freshDir();
    mkdirSync(resolve(d, "home/.config"), { recursive: true });
    const outside = resolve(d, "outside");
    writeFileSync(outside, "untouched");
    symlinkSync(outside, resolve(d, "home/.config/volute.json"));
    assert.throws(() => writeVoluteConfig(d, { model: "x" }));
    assert.equal(readFileSync(outside, "utf-8"), "untouched");
    // A dangling link must not be followed into creating its target either.
    rmSync(outside);
    assert.throws(() => writeVoluteConfig(d, { model: "x" }));
    assert.equal(existsSync(outside), false);
  });

  it("refuses a .config/ that a symlink leads out of the mind", () => {
    const d = freshDir();
    const elsewhere = mkdtempSync(resolve(tmpdir(), "volute-config-elsewhere-"));
    try {
      mkdirSync(resolve(d, "home"), { recursive: true });
      symlinkSync(elsewhere, resolve(d, "home/.config"));
      assert.throws(() => writeVoluteConfig(d, {}), /resolves outside/);
      assert.deepEqual(readdirSync(elsewhere), []);
    } finally {
      rmSync(elsewhere, { recursive: true });
    }
  });

  it("hands each created path to the mind, and a variant's to its parent", async () => {
    const parent = `own-parent-${Date.now()}`;
    const variant = `${parent}-v`;
    await addMind(parent, 4197);
    await addVariant(variant, parent, 4196, "/tmp/unused", "v");
    try {
      const calls: [string, string][] = [];
      const record = async (p: string, n: string) => {
        calls.push([p, n]);
      };
      await chownVoluteConfigPaths(parent, ["/a", "/b"], record);
      await chownVoluteConfigPaths(variant, ["/c"], record);
      await chownVoluteConfigPaths(parent, [], record);
      assert.deepEqual(calls, [
        ["/a", parent],
        ["/b", parent],
        ["/c", parent],
      ]);
    } finally {
      await removeMind(variant);
      await removeMind(parent);
    }
  });
});
