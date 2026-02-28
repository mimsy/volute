import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { voluteHome, writeRegistry } from "../src/lib/registry.js";
import { backfillTemplateHashes, notifyVersionUpdate } from "../src/lib/version-notify.js";

const statePath = () => resolve(voluteHome(), "version-notify.json");
const registryPath = () => resolve(voluteHome(), "minds.json");

function writeState(state: { lastNotifiedVersion: string }) {
  writeFileSync(statePath(), JSON.stringify(state));
}

function readState(): { lastNotifiedVersion: string } | null {
  try {
    return JSON.parse(readFileSync(statePath(), "utf-8"));
  } catch {
    return null;
  }
}

describe("backfillTemplateHashes", () => {
  beforeEach(() => {
    mkdirSync(voluteHome(), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(registryPath());
    } catch {}
  });

  it("sets templateHash for minds without one", () => {
    writeRegistry([
      {
        name: "test-mind",
        port: 4100,
        created: new Date().toISOString(),
        running: false,
        template: "claude",
      },
    ]);

    backfillTemplateHashes();

    const entries = JSON.parse(readFileSync(registryPath(), "utf-8"));
    assert.ok(entries[0].templateHash, "should have templateHash set");
    assert.equal(entries[0].templateHash.length, 64, "should be SHA-256 hex");
  });

  it("skips minds that already have a hash", () => {
    writeRegistry([
      {
        name: "test-mind",
        port: 4100,
        created: new Date().toISOString(),
        running: false,
        template: "claude",
        templateHash: "existing-hash",
      },
    ]);

    backfillTemplateHashes();

    const entries = JSON.parse(readFileSync(registryPath(), "utf-8"));
    assert.equal(entries[0].templateHash, "existing-hash", "should not overwrite existing hash");
  });

  it("skips seed minds", () => {
    writeRegistry([
      {
        name: "seed-mind",
        port: 4100,
        created: new Date().toISOString(),
        running: false,
        stage: "seed",
      },
    ]);

    backfillTemplateHashes();

    const entries = JSON.parse(readFileSync(registryPath(), "utf-8"));
    assert.equal(entries[0].templateHash, undefined, "seed minds should not get a hash");
  });
});

describe("notifyVersionUpdate", () => {
  beforeEach(() => {
    mkdirSync(voluteHome(), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(statePath());
    } catch {}
    try {
      rmSync(registryPath());
    } catch {}
  });

  it("first run records version without notifying", async () => {
    writeRegistry([]);

    await notifyVersionUpdate();

    const state = readState();
    assert.ok(state !== null, "should create state file");
    assert.ok(state.lastNotifiedVersion.length > 0, "should record version");
  });

  it("same version skips notification", async () => {
    writeRegistry([
      {
        name: "test-mind",
        port: 4100,
        created: new Date().toISOString(),
        running: true,
        template: "claude",
      },
    ]);

    // First run: record version
    await notifyVersionUpdate();
    const state1 = readState();

    // Second run: same version, should be a no-op
    await notifyVersionUpdate();
    const state2 = readState();

    assert.deepEqual(state1, state2, "state should not change on same version");
  });

  it("version change updates state", async () => {
    writeRegistry([]);
    writeState({ lastNotifiedVersion: "0.0.1" });

    await notifyVersionUpdate();

    const state = readState();
    assert.ok(state !== null);
    assert.notEqual(state.lastNotifiedVersion, "0.0.1", "should update to current version");
  });

  it("skips notification when no running minds", async () => {
    writeRegistry([
      {
        name: "stopped-mind",
        port: 4100,
        created: new Date().toISOString(),
        running: false,
        template: "claude",
      },
    ]);
    writeState({ lastNotifiedVersion: "0.0.1" });

    // Should not throw even with no running minds
    await notifyVersionUpdate();

    const state = readState();
    assert.ok(state !== null);
    assert.notEqual(state.lastNotifiedVersion, "0.0.1");
  });

  it("skips seed minds", async () => {
    writeRegistry([
      {
        name: "seed-mind",
        port: 4100,
        created: new Date().toISOString(),
        running: true,
        stage: "seed",
      },
    ]);
    writeState({ lastNotifiedVersion: "0.0.1" });

    // Should not throw — seed minds are filtered out
    await notifyVersionUpdate();

    const state = readState();
    assert.ok(state !== null);
    assert.notEqual(state.lastNotifiedVersion, "0.0.1");
  });
});
