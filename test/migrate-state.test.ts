import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { migrateMindState } from "../src/lib/migrate-state.js";
import { addMind, mindDir, removeMind, stateDir } from "../src/lib/registry.js";

const TEST_MIND = `migrate-test-${Date.now()}`;

describe("migrateMindState", () => {
  beforeEach(() => {
    addMind(TEST_MIND, 4999);
    const dir = mindDir(TEST_MIND);
    mkdirSync(resolve(dir, ".volute"), { recursive: true });
  });

  afterEach(() => {
    removeMind(TEST_MIND);
    // Clean up state dir created by migration
    const state = stateDir(TEST_MIND);
    if (existsSync(state)) {
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("copies env.json from mind .volute to state dir", () => {
    const src = resolve(mindDir(TEST_MIND), ".volute", "env.json");
    writeFileSync(src, JSON.stringify({ FOO: "bar" }));

    migrateMindState(TEST_MIND);

    const dest = resolve(stateDir(TEST_MIND), "env.json");
    assert.ok(existsSync(dest));
    assert.deepEqual(JSON.parse(readFileSync(dest, "utf-8")), { FOO: "bar" });
  });

  it("copies channels.json from mind .volute to state dir", () => {
    const src = resolve(mindDir(TEST_MIND), ".volute", "channels.json");
    writeFileSync(src, JSON.stringify({ "discord:general": { platformId: "123" } }));

    migrateMindState(TEST_MIND);

    const dest = resolve(stateDir(TEST_MIND), "channels.json");
    assert.ok(existsSync(dest));
  });

  it("does not overwrite existing files in state dir", () => {
    const src = resolve(mindDir(TEST_MIND), ".volute", "env.json");
    writeFileSync(src, JSON.stringify({ OLD: "value" }));

    const destDir = stateDir(TEST_MIND);
    mkdirSync(destDir, { recursive: true });
    const dest = resolve(destDir, "env.json");
    writeFileSync(dest, JSON.stringify({ NEW: "value" }));

    migrateMindState(TEST_MIND);

    assert.deepEqual(JSON.parse(readFileSync(dest, "utf-8")), { NEW: "value" });
  });

  it("no-ops when mind has no .volute directory", () => {
    // Remove the .volute dir we created in beforeEach
    rmSync(resolve(mindDir(TEST_MIND), ".volute"), { recursive: true, force: true });

    migrateMindState(TEST_MIND);

    assert.ok(!existsSync(stateDir(TEST_MIND)));
  });

  it("migrates logs directory", () => {
    const srcLogs = resolve(mindDir(TEST_MIND), ".volute", "logs");
    mkdirSync(srcLogs, { recursive: true });
    writeFileSync(resolve(srcLogs, "mind.log"), "log content");

    migrateMindState(TEST_MIND);

    const destLog = resolve(stateDir(TEST_MIND), "logs", "mind.log");
    assert.ok(existsSync(destLog));
    assert.equal(readFileSync(destLog, "utf-8"), "log content");
  });
});
