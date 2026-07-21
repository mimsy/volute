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
  getMindDir: () => Promise<string | null>;
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

  it("provisions the schedule and sets the marker when a spirit exists", async () => {
    writeConfig({ schedules: [] });
    const ctx = makeCtx({ db, getSpiritName: () => "volute", getMindDir: async () => spiritDir });

    await provisionSpiritSchedule(ctx);

    const config = readConfig();
    assert.ok(config.schedules?.some((s) => s.id === "intention-review"));
    assert.equal(isMarked(), true);
  });

  it("does not duplicate an already-present schedule but still marks provisioned", async () => {
    writeConfig({ schedules: [{ id: "intention-review", cron: "0 0 * * *", enabled: true }] });
    const ctx = makeCtx({ db, getSpiritName: () => "volute", getMindDir: async () => spiritDir });

    await provisionSpiritSchedule(ctx);

    const matches = (readConfig().schedules ?? []).filter((s) => s.id === "intention-review");
    assert.equal(matches.length, 1);
    assert.equal(isMarked(), true);
  });

  // The important case: a host or the spirit deleting the schedule on purpose
  // must not have it silently come back on the next daemon start.
  it("is a no-op once the marker is set, even if the schedule row is gone", async () => {
    writeConfig({ schedules: [] });
    db.prepare("INSERT INTO meta (key, value) VALUES ('spirit_schedule_provisioned', 'x')").run();
    const ctx = makeCtx({ db, getSpiritName: () => "volute", getMindDir: async () => spiritDir });

    await provisionSpiritSchedule(ctx);

    assert.equal(
      (readConfig().schedules ?? []).length,
      0,
      "deleted schedule must not be resurrected",
    );
  });

  // Provisioning is once-only, so a schedule written with the old singular noun
  // (`volute intention review-due` — a noun the CLI never registered) would fail
  // silently every morning forever. Correcting the constant isn't enough; the
  // already-written string has to be repaired past the marker.
  it("repairs an already-provisioned schedule carrying the old singular command", async () => {
    writeConfig({
      schedules: [
        {
          id: "intention-review",
          cron: "0 9 * * *",
          script: "volute intention review-due",
          enabled: true,
        },
      ],
    });
    db.prepare("INSERT INTO meta (key, value) VALUES ('spirit_schedule_provisioned', 'x')").run();
    const ctx = makeCtx({ db, getSpiritName: () => "volute", getMindDir: async () => spiritDir });

    await provisionSpiritSchedule(ctx);

    const entry = (readConfig().schedules ?? []).find((s) => s.id === "intention-review") as
      | { script?: string; cron?: string; enabled?: boolean }
      | undefined;
    assert.equal(entry?.script, "volute intentions review-due");
    assert.equal(entry?.cron, "0 9 * * *", "repair must not reset the host's cron");
    assert.equal(entry?.enabled, true, "repair must not re-enable or disable the schedule");
  });

  // The repair is narrow on purpose: only strings we know we mis-shipped get rewritten.
  it("leaves a script the spirit chose for itself alone", async () => {
    writeConfig({
      schedules: [
        { id: "intention-review", script: "volute intentions review-due --mind me", enabled: true },
      ],
    });
    db.prepare("INSERT INTO meta (key, value) VALUES ('spirit_schedule_provisioned', 'x')").run();
    const ctx = makeCtx({ db, getSpiritName: () => "volute", getMindDir: async () => spiritDir });

    await provisionSpiritSchedule(ctx);

    const entry = (readConfig().schedules ?? []).find((s) => s.id === "intention-review") as
      | { script?: string }
      | undefined;
    assert.equal(entry?.script, "volute intentions review-due --mind me");
  });

  // The repair must not become a back door around "respect deletion".
  it("does not resurrect a deleted schedule while repairing", async () => {
    writeConfig({ schedules: [{ id: "something-else", script: "volute intentions list" }] });
    db.prepare("INSERT INTO meta (key, value) VALUES ('spirit_schedule_provisioned', 'x')").run();
    const ctx = makeCtx({ db, getSpiritName: () => "volute", getMindDir: async () => spiritDir });

    await provisionSpiritSchedule(ctx);

    assert.equal(
      (readConfig().schedules ?? []).some((s) => s.id === "intention-review"),
      false,
      "a deliberately deleted schedule must stay deleted",
    );
  });

  it("does nothing and does not mark when there is no spirit configured yet", async () => {
    writeConfig({ schedules: [] });
    const ctx = makeCtx({ db, getSpiritName: () => null, getMindDir: async () => spiritDir });

    await provisionSpiritSchedule(ctx);

    assert.equal(isMarked(), false);
    assert.equal((readConfig().schedules ?? []).length, 0);
  });

  it("does nothing and does not mark when the spirit's directory does not exist yet", async () => {
    const ctx = makeCtx({ db, getSpiritName: () => "volute", getMindDir: async () => null });

    await provisionSpiritSchedule(ctx);

    assert.equal(isMarked(), false);
  });

  it("does not throw and does not mark when volute.json is missing", async () => {
    rmSync(configPath, { force: true });
    const ctx = makeCtx({ db, getSpiritName: () => "volute", getMindDir: async () => spiritDir });

    await assert.doesNotReject(() => provisionSpiritSchedule(ctx));
    assert.equal(isMarked(), false);
  });

  it("does not throw and does not mark when volute.json is unparseable", async () => {
    writeFileSync(configPath, "not json");
    const ctx = makeCtx({ db, getSpiritName: () => "volute", getMindDir: async () => spiritDir });

    await assert.doesNotReject(() => provisionSpiritSchedule(ctx));
    assert.equal(isMarked(), false);
  });

  it("does not throw when volute.json is unwritable", async () => {
    writeConfig({ schedules: [] });
    chmodSync(configPath, 0o444);
    const ctx = makeCtx({ db, getSpiritName: () => "volute", getMindDir: async () => spiritDir });

    try {
      await assert.doesNotReject(() => provisionSpiritSchedule(ctx));
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
