import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Database as ExtDb, ExtensionContext } from "@volute/extensions";
import Database from "libsql";

import { initDb } from "../packages/extensions/intentions/src/db.js";
import { provisionSpiritSchedule } from "../packages/extensions/intentions/src/spirit-schedule.js";

// Same shape of fake-ctx builder as test/pages-commons.test.ts's maybeSendCommonsCue
// tests — only the fields provisionSpiritSchedule actually reads need overriding.
function makeCtx(overrides: {
  db: ExtDb;
  getSpiritName: () => string | null;
  getMindDir: () => string | null;
}): ExtensionContext {
  return {
    db: overrides.db,
    authMiddleware: (() => {}) as unknown as ExtensionContext["authMiddleware"],
    requireSelf: (() => () => {}) as unknown as ExtensionContext["requireSelf"],
    resolveUser: () => null,
    getUser: async () => null,
    getUserByUsername: async () => null,
    publishActivity: () => {},
    getMindDir: overrides.getMindDir,
    getSystemsConfig: () => null,
    announceToSystem: async () => {},
    recordNotice: async () => {},
    isIsolationEnabled: () => false,
    getMindUser: (name: string) => `mind-${name}`,
    getSpiritName: overrides.getSpiritName,
    dataDir: "/tmp",
  } as ExtensionContext;
}

describe("provisionSpiritSchedule", () => {
  let db: ExtDb;
  let spiritDir: string;
  let configPath: string;

  beforeEach(() => {
    db = new Database(":memory:") as unknown as ExtDb;
    initDb(db);
    spiritDir = mkdtempSync(join(tmpdir(), "intentions-spirit-"));
    mkdirSync(resolve(spiritDir, "home/.config"), { recursive: true });
    configPath = resolve(spiritDir, "home/.config/volute.json");
  });

  afterEach(() => {
    db.close();
    rmSync(spiritDir, { recursive: true, force: true });
  });

  function writeConfig(config: unknown) {
    writeFileSync(configPath, JSON.stringify(config));
  }

  function readConfig(): { schedules?: { id: string }[] } {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  }

  function isMarked(): boolean {
    return !!db.prepare("SELECT 1 FROM meta WHERE key = 'spirit_schedule_provisioned'").get();
  }

  it("provisions the schedule and sets the marker when a spirit exists", () => {
    writeConfig({ schedules: [] });
    const ctx = makeCtx({ db, getSpiritName: () => "volute", getMindDir: () => spiritDir });

    provisionSpiritSchedule(ctx);

    const config = readConfig();
    assert.ok(config.schedules?.some((s) => s.id === "intention-review"));
    assert.equal(isMarked(), true);
  });

  it("does not duplicate an already-present schedule but still marks provisioned", () => {
    writeConfig({ schedules: [{ id: "intention-review", cron: "0 0 * * *", enabled: true }] });
    const ctx = makeCtx({ db, getSpiritName: () => "volute", getMindDir: () => spiritDir });

    provisionSpiritSchedule(ctx);

    const matches = (readConfig().schedules ?? []).filter((s) => s.id === "intention-review");
    assert.equal(matches.length, 1);
    assert.equal(isMarked(), true);
  });

  // The important case: a host or the spirit deleting the schedule on purpose
  // must not have it silently come back on the next daemon start.
  it("is a no-op once the marker is set, even if the schedule row is gone", () => {
    writeConfig({ schedules: [] });
    db.prepare("INSERT INTO meta (key, value) VALUES ('spirit_schedule_provisioned', 'x')").run();
    const ctx = makeCtx({ db, getSpiritName: () => "volute", getMindDir: () => spiritDir });

    provisionSpiritSchedule(ctx);

    assert.equal(
      (readConfig().schedules ?? []).length,
      0,
      "deleted schedule must not be resurrected",
    );
  });

  it("does nothing and does not mark when there is no spirit configured yet", () => {
    writeConfig({ schedules: [] });
    const ctx = makeCtx({ db, getSpiritName: () => null, getMindDir: () => spiritDir });

    provisionSpiritSchedule(ctx);

    assert.equal(isMarked(), false);
    assert.equal((readConfig().schedules ?? []).length, 0);
  });

  it("does nothing and does not mark when the spirit's directory does not exist yet", () => {
    const ctx = makeCtx({ db, getSpiritName: () => "volute", getMindDir: () => null });

    provisionSpiritSchedule(ctx);

    assert.equal(isMarked(), false);
  });

  it("does not throw and does not mark when volute.json is missing", () => {
    rmSync(configPath, { force: true });
    const ctx = makeCtx({ db, getSpiritName: () => "volute", getMindDir: () => spiritDir });

    assert.doesNotThrow(() => provisionSpiritSchedule(ctx));
    assert.equal(isMarked(), false);
  });

  it("does not throw and does not mark when volute.json is unparseable", () => {
    writeFileSync(configPath, "not json");
    const ctx = makeCtx({ db, getSpiritName: () => "volute", getMindDir: () => spiritDir });

    assert.doesNotThrow(() => provisionSpiritSchedule(ctx));
    assert.equal(isMarked(), false);
  });

  it("does not throw when volute.json is unwritable", () => {
    writeConfig({ schedules: [] });
    chmodSync(configPath, 0o444);
    const ctx = makeCtx({ db, getSpiritName: () => "volute", getMindDir: () => spiritDir });

    try {
      assert.doesNotThrow(() => provisionSpiritSchedule(ctx));
      // root ignores the read-only bit, so skip the "stays unmarked" assertion
      // when tests happen to run as root — the throw-safety is the real guarantee.
      if (process.getuid?.() !== 0) {
        assert.equal(isMarked(), false);
      }
    } finally {
      chmodSync(configPath, 0o644);
    }
  });
});
