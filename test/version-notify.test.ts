import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  addMind,
  findMind,
  removeMind,
  setMindTemplateHash,
  voluteSystemDir,
} from "../src/lib/registry.js";
import { backfillTemplateHashes, notifyVersionUpdate } from "../src/lib/version-notify.js";

const statePath = () => resolve(voluteSystemDir(), "version-notify.json");

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
  const testMind = `backfill-test-${Date.now()}`;

  beforeEach(() => {
    mkdirSync(voluteSystemDir(), { recursive: true });
  });

  afterEach(async () => {
    try {
      await removeMind(testMind);
    } catch {}
  });

  it("sets templateHash for minds without one", async () => {
    await addMind(testMind, 4100, undefined, "claude");

    await backfillTemplateHashes();

    const entry = await findMind(testMind);
    assert.ok(entry?.templateHash, "should have templateHash set");
    assert.equal(entry!.templateHash!.length, 64, "should be SHA-256 hex");
  });

  it("skips minds that already have a hash", async () => {
    await addMind(testMind, 4100, undefined, "claude");
    await setMindTemplateHash(testMind, "existing-hash");

    await backfillTemplateHashes();

    const entry = await findMind(testMind);
    assert.equal(entry?.templateHash, "existing-hash", "should not overwrite existing hash");
  });

  it("skips seed minds", async () => {
    await addMind(testMind, 4100, "seed");

    await backfillTemplateHashes();

    const entry = await findMind(testMind);
    assert.equal(entry?.templateHash, undefined, "seed minds should not get a hash");
  });
});

describe("notifyVersionUpdate", () => {
  beforeEach(() => {
    mkdirSync(voluteSystemDir(), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(statePath());
    } catch {}
  });

  it("records current version on first run", async () => {
    await notifyVersionUpdate();
    const state = readState();
    assert.ok(state, "should write state file");
    assert.ok(state!.lastNotifiedVersion, "should have version");
  });

  it("does not send if version unchanged", async () => {
    const { getCurrentVersion } = await import("../src/lib/update-check.js");
    writeState({ lastNotifiedVersion: getCurrentVersion() });

    // Should complete without error
    await notifyVersionUpdate();
    const state = readState();
    assert.equal(state!.lastNotifiedVersion, getCurrentVersion());
  });
});
