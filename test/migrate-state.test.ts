import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { addMind, mindDir, removeMind, stateDir } from "@volute/shared/registry";
import { migrateDotVoluteDir, migrateMindState } from "../src/lib/migrate-state.js";

const TEST_MIND = `migrate-test-${Date.now()}`;

describe("migrateMindState", () => {
  beforeEach(() => {
    addMind(TEST_MIND, 4999);
    const dir = mindDir(TEST_MIND);
    mkdirSync(resolve(dir, ".mind"), { recursive: true });
  });

  afterEach(() => {
    removeMind(TEST_MIND);
    // Clean up state dir created by migration
    const state = stateDir(TEST_MIND);
    if (existsSync(state)) {
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("copies env.json from mind .mind to state dir", () => {
    const src = resolve(mindDir(TEST_MIND), ".mind", "env.json");
    writeFileSync(src, JSON.stringify({ FOO: "bar" }));

    migrateMindState(TEST_MIND);

    const dest = resolve(stateDir(TEST_MIND), "env.json");
    assert.ok(existsSync(dest));
    assert.deepEqual(JSON.parse(readFileSync(dest, "utf-8")), { FOO: "bar" });
  });

  it("copies channels.json from mind .mind to state dir", () => {
    const src = resolve(mindDir(TEST_MIND), ".mind", "channels.json");
    writeFileSync(src, JSON.stringify({ "discord:general": { platformId: "123" } }));

    migrateMindState(TEST_MIND);

    const dest = resolve(stateDir(TEST_MIND), "channels.json");
    assert.ok(existsSync(dest));
  });

  it("does not overwrite existing files in state dir", () => {
    const src = resolve(mindDir(TEST_MIND), ".mind", "env.json");
    writeFileSync(src, JSON.stringify({ OLD: "value" }));

    const destDir = stateDir(TEST_MIND);
    mkdirSync(destDir, { recursive: true });
    const dest = resolve(destDir, "env.json");
    writeFileSync(dest, JSON.stringify({ NEW: "value" }));

    migrateMindState(TEST_MIND);

    assert.deepEqual(JSON.parse(readFileSync(dest, "utf-8")), { NEW: "value" });
  });

  it("no-ops when mind has no .mind directory", () => {
    // Remove the .mind dir we created in beforeEach
    rmSync(resolve(mindDir(TEST_MIND), ".mind"), { recursive: true, force: true });

    migrateMindState(TEST_MIND);

    assert.ok(!existsSync(stateDir(TEST_MIND)));
  });

  it("migrates logs directory", () => {
    const srcLogs = resolve(mindDir(TEST_MIND), ".mind", "logs");
    mkdirSync(srcLogs, { recursive: true });
    writeFileSync(resolve(srcLogs, "mind.log"), "log content");

    migrateMindState(TEST_MIND);

    const destLog = resolve(stateDir(TEST_MIND), "logs", "mind.log");
    assert.ok(existsSync(destLog));
    assert.equal(readFileSync(destLog, "utf-8"), "log content");
  });
});

const RENAME_MIND = `rename-test-${Date.now()}`;

describe("migrateDotVoluteDir", () => {
  beforeEach(() => {
    addMind(RENAME_MIND, 4998);
  });

  afterEach(() => {
    const dir = mindDir(RENAME_MIND);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    removeMind(RENAME_MIND);
  });

  it("renames .volute/ to .mind/ when only .volute exists", () => {
    const dir = mindDir(RENAME_MIND);
    const oldDir = resolve(dir, ".volute");
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(resolve(oldDir, "session.json"), '{"id":"test"}');

    migrateDotVoluteDir(RENAME_MIND);

    assert.ok(!existsSync(oldDir));
    assert.ok(existsSync(resolve(dir, ".mind")));
    assert.equal(readFileSync(resolve(dir, ".mind", "session.json"), "utf-8"), '{"id":"test"}');
  });

  it("no-ops when .mind/ already exists", () => {
    const dir = mindDir(RENAME_MIND);
    const oldDir = resolve(dir, ".volute");
    const newDir = resolve(dir, ".mind");
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });
    writeFileSync(resolve(oldDir, "old.json"), "old");
    writeFileSync(resolve(newDir, "new.json"), "new");

    migrateDotVoluteDir(RENAME_MIND);

    // Both dirs still exist — .volute was not renamed over .mind
    assert.ok(existsSync(oldDir));
    assert.ok(existsSync(newDir));
    assert.equal(readFileSync(resolve(newDir, "new.json"), "utf-8"), "new");
  });

  it("no-ops when neither directory exists", () => {
    const dir = mindDir(RENAME_MIND);
    mkdirSync(dir, { recursive: true });

    migrateDotVoluteDir(RENAME_MIND);

    assert.ok(!existsSync(resolve(dir, ".volute")));
    assert.ok(!existsSync(resolve(dir, ".mind")));
  });
});
