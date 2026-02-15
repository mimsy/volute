import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { migrateAgentState } from "../src/lib/migrate-state.js";
import { addAgent, agentDir, removeAgent, stateDir } from "../src/lib/registry.js";

const TEST_AGENT = `migrate-test-${Date.now()}`;

describe("migrateAgentState", () => {
  beforeEach(() => {
    addAgent(TEST_AGENT, 4999);
    const dir = agentDir(TEST_AGENT);
    mkdirSync(resolve(dir, ".volute"), { recursive: true });
  });

  afterEach(() => {
    removeAgent(TEST_AGENT);
    // Clean up state dir created by migration
    const state = stateDir(TEST_AGENT);
    if (existsSync(state)) {
      rmSync(state, { recursive: true, force: true });
    }
  });

  it("copies env.json from agent .volute to state dir", () => {
    const src = resolve(agentDir(TEST_AGENT), ".volute", "env.json");
    writeFileSync(src, JSON.stringify({ FOO: "bar" }));

    migrateAgentState(TEST_AGENT);

    const dest = resolve(stateDir(TEST_AGENT), "env.json");
    assert.ok(existsSync(dest));
    assert.deepEqual(JSON.parse(readFileSync(dest, "utf-8")), { FOO: "bar" });
  });

  it("copies channels.json from agent .volute to state dir", () => {
    const src = resolve(agentDir(TEST_AGENT), ".volute", "channels.json");
    writeFileSync(src, JSON.stringify({ "discord:general": { platformId: "123" } }));

    migrateAgentState(TEST_AGENT);

    const dest = resolve(stateDir(TEST_AGENT), "channels.json");
    assert.ok(existsSync(dest));
  });

  it("does not overwrite existing files in state dir", () => {
    const src = resolve(agentDir(TEST_AGENT), ".volute", "env.json");
    writeFileSync(src, JSON.stringify({ OLD: "value" }));

    const destDir = stateDir(TEST_AGENT);
    mkdirSync(destDir, { recursive: true });
    const dest = resolve(destDir, "env.json");
    writeFileSync(dest, JSON.stringify({ NEW: "value" }));

    migrateAgentState(TEST_AGENT);

    assert.deepEqual(JSON.parse(readFileSync(dest, "utf-8")), { NEW: "value" });
  });

  it("no-ops when agent has no .volute directory", () => {
    // Remove the .volute dir we created in beforeEach
    rmSync(resolve(agentDir(TEST_AGENT), ".volute"), { recursive: true, force: true });

    migrateAgentState(TEST_AGENT);

    assert.ok(!existsSync(stateDir(TEST_AGENT)));
  });

  it("migrates logs directory", () => {
    const srcLogs = resolve(agentDir(TEST_AGENT), ".volute", "logs");
    mkdirSync(srcLogs, { recursive: true });
    writeFileSync(resolve(srcLogs, "agent.log"), "log content");

    migrateAgentState(TEST_AGENT);

    const destLog = resolve(stateDir(TEST_AGENT), "logs", "agent.log");
    assert.ok(existsSync(destLog));
    assert.equal(readFileSync(destLog, "utf-8"), "log content");
  });
});
