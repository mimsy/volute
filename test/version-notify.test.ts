import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  initMindManager,
  tryGetMindManager,
} from "../packages/daemon/src/lib/daemon/mind-manager.js";
import { startMindFull, wakeMind } from "../packages/daemon/src/lib/daemon/mind-service.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { restartOntoMerge } from "../packages/daemon/src/lib/mind/merge-restart.js";
import {
  addMind,
  findMind,
  removeMind,
  setMindRunning,
  setMindTemplateHash,
  stateDir,
  voluteSystemDir,
} from "../packages/daemon/src/lib/mind/registry.js";
import { setChangelogForTesting } from "../packages/daemon/src/lib/release-notes.js";
import { systemEvents } from "../packages/daemon/src/lib/schema.js";
import { getCurrentVersion } from "../packages/daemon/src/lib/update-check.js";
import {
  backfillTemplateHashes,
  notifyMindOfVersion,
  notifyVersionUpdate,
  resetVersionNotifyState,
  shouldSuggestUpgrade,
} from "../packages/daemon/src/lib/version-notify.js";

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
    const { getCurrentVersion } = await import("../packages/daemon/src/lib/update-check.js");
    writeState({ lastNotifiedVersion: getCurrentVersion() });

    // Should complete without error
    await notifyVersionUpdate();
    const state = readState();
    assert.equal(state!.lastNotifiedVersion, getCurrentVersion());
  });
});

describe("version notice for minds started after boot", () => {
  const names: string[] = [];
  let port = 4700;

  async function mind(opts: { running: boolean }): Promise<string> {
    const name = `vn-${Date.now()}-${names.length}`;
    names.push(name);
    await addMind(name, port++, undefined, "claude");
    if (opts.running) await setMindRunning(name, true);
    return name;
  }

  async function versionNotices(name: string) {
    const db = await getDb();
    return db
      .select()
      .from(systemEvents)
      .where(and(eq(systemEvents.mind, name), eq(systemEvents.type, "version")));
  }

  beforeEach(() => {
    mkdirSync(voluteSystemDir(), { recursive: true });
    resetVersionNotifyState();
  });

  afterEach(async () => {
    const db = await getDb();
    for (const name of names.splice(0)) {
      await db.delete(systemEvents).where(eq(systemEvents.mind, name));
      try {
        await removeMind(name);
      } catch {}
      rmSync(stateDir(name), { recursive: true, force: true });
    }
    rmSync(statePath(), { force: true });
  });

  it("tells a mind running at boot exactly once", async () => {
    const name = await mind({ running: true });
    writeState({ lastNotifiedVersion: "0.0.1" });

    // Its boot-time start runs before the pass: nothing yet (#960 ordering).
    await notifyMindOfVersion(name);
    assert.equal((await versionNotices(name)).length, 0);

    await notifyVersionUpdate();
    const notices = await versionNotices(name);
    assert.equal(notices.length, 1);
    assert.match(notices[0].body, /^Volute has been updated to v/);

    // A later restart doesn't repeat it.
    await notifyMindOfVersion(name);
    assert.equal((await versionNotices(name)).length, 1);
  });

  it("tells a mind stopped through the upgrade exactly once, when it starts", async () => {
    const name = await mind({ running: false });
    writeState({ lastNotifiedVersion: "0.0.1" });

    await notifyVersionUpdate();
    assert.equal((await versionNotices(name)).length, 0, "not running at boot");

    await notifyMindOfVersion(name);
    assert.equal((await versionNotices(name)).length, 1);
    await notifyMindOfVersion(name);
    assert.equal((await versionNotices(name)).length, 1);
  });

  it("tells a mind starting while the boot pass runs exactly once", async () => {
    const running = await mind({ running: true });
    const stopped = await mind({ running: false });
    writeState({ lastNotifiedVersion: "0.0.1" });

    await Promise.all([
      notifyVersionUpdate(),
      notifyMindOfVersion(running),
      notifyMindOfVersion(stopped), // started during boot, before the pass
    ]);
    assert.equal((await versionNotices(running)).length, 1);
    assert.equal((await versionNotices(stopped)).length, 1);
  });

  it("promises an automatic upgrade only while the boot upgrade pass is ahead", async () => {
    const running = await mind({ running: true });
    const stopped = await mind({ running: false });
    await setMindTemplateHash(running, "stale");
    await setMindTemplateHash(stopped, "stale");
    writeState({ lastNotifiedVersion: "0.0.1" });

    await notifyVersionUpdate();
    await notifyMindOfVersion(stopped);
    const [atBoot] = await versionNotices(running);
    const [later] = await versionNotices(stopped);
    assert.match(atBoot.body, /applied automatically/);
    assert.match(later.body, new RegExp(`volute mind upgrade ${stopped}`));
  });

  it("tells nobody on a first run or when the version is unchanged", async () => {
    const running = await mind({ running: true });
    const stopped = await mind({ running: false });

    await notifyVersionUpdate(); // first run: no global state
    await notifyMindOfVersion(stopped);
    resetVersionNotifyState();
    await notifyVersionUpdate(); // same version
    await notifyMindOfVersion(running);
    await notifyMindOfVersion(stopped);

    assert.equal((await versionNotices(running)).length, 0);
    assert.equal((await versionNotices(stopped)).length, 0);
  });

  it("is sent by a later start and by a wake", async () => {
    const mgr = tryGetMindManager() ?? initMindManager();
    const origStart = mgr.startMind;
    mgr.startMind = async () => {};
    try {
      const started = await mind({ running: false });
      const woken = await mind({ running: false });
      writeState({ lastNotifiedVersion: "0.0.1" });
      await notifyVersionUpdate();

      await startMindFull(started);
      await wakeMind(woken);
      for (const name of [started, woken]) {
        for (let i = 0; i < 100 && (await versionNotices(name)).length === 0; i++) {
          await new Promise((r) => setTimeout(r, 20));
        }
        assert.equal((await versionNotices(name)).length, 1, name);
      }
    } finally {
      mgr.startMind = origStart;
    }
  });

  it("is sent, once, when an upgrade starts a mind that was stopped (#1365)", async () => {
    const name = await mind({ running: false });
    writeState({ lastNotifiedVersion: "0.0.1" });
    await notifyVersionUpdate();
    assert.equal((await versionNotices(name)).length, 0, "not running at boot");

    const manager = {
      isUpOrRecovering: () => false,
      stopMind: async () => {},
      startMind: async () => {},
      setPendingContext: () => {},
    };
    // Upgraded twice: the second start finds the record and says nothing more.
    for (let run = 0; run < 2; run++) {
      await restartOntoMerge(manager, name, { type: "upgraded" }, { isAsleep: () => false });
      for (let i = 0; i < 100 && (await versionNotices(name)).length === 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await versionNotices(name)).length, 1);
  });

  it("tells a mind back from a long sleep every release it missed, newest first", async () => {
    // A fixture CHANGELOG, so the cap is exercised whatever the real one's sections hold:
    // the current release, then 0.0.9 down to 0.0.1. The two newest are ~2500 characters
    // each, so they fit together and a third would not.
    const current = getCurrentVersion();
    const older = Array.from({ length: 9 }, (_, i) => `0.0.${9 - i}`);
    const body = (v: string, i: number) => `* fix in ${v} ${i < 3 ? "x".repeat(2500) : ""}`;
    setChangelogForTesting(
      [
        "# Changelog",
        ...[current, ...older].map((v, i) => `## [${v}](url)\n\n### Bug Fixes\n\n${body(v, i)}`),
      ].join("\n\n"),
    );
    try {
      const name = await mind({ running: false });
      mkdirSync(stateDir(name), { recursive: true });
      writeFileSync(
        resolve(stateDir(name), "version-notified.json"),
        JSON.stringify({ version: "0.0.1" }),
      );
      writeState({ lastNotifiedVersion: "0.0.1" });
      await notifyVersionUpdate();

      await notifyMindOfVersion(name);
      const [notice] = await versionNotices(name);
      const at = [`## v${current}\n`, "## v0.0.9\n"].map((h) => notice.body.indexOf(h));
      assert.ok(at[0] > 0 && at[1] > at[0], notice.body);
      assert.ok(!notice.body.includes("## v0.0.8"));
      assert.ok(!notice.body.includes("## v0.0.1"));
      assert.ok(
        notice.body.endsWith(
          "…and 7 earlier releases since v0.0.1; see CHANGELOG.md in the Volute install",
        ),
        notice.body.slice(-200),
      );
    } finally {
      setChangelogForTesting(undefined);
    }
  });

  it("does not tell a mind created after boot about the version it was born into", async () => {
    writeState({ lastNotifiedVersion: "0.0.1" });
    await notifyVersionUpdate();

    const name = await mind({ running: false });
    await notifyMindOfVersion(name);
    assert.equal((await versionNotices(name)).length, 0);
  });
});

describe("shouldSuggestUpgrade", () => {
  it("suggests upgrade for a regular mind whose template hash changed", () => {
    assert.equal(shouldSuggestUpgrade({ mindType: "mind", templateHash: "old" }, "new"), true);
  });

  it("never suggests upgrade to the spirit, even on a hash change", () => {
    // The spirit upgrades via syncSpiritTemplate() on restart, not `mind upgrade`.
    assert.equal(shouldSuggestUpgrade({ mindType: "spirit", templateHash: "old" }, "new"), false);
  });

  it("does not suggest upgrade when the hash is unchanged", () => {
    assert.equal(shouldSuggestUpgrade({ mindType: "mind", templateHash: "same" }, "same"), false);
  });

  it("does not suggest upgrade when a hash is missing", () => {
    assert.equal(shouldSuggestUpgrade({ mindType: "mind", templateHash: null }, "new"), false);
    assert.equal(shouldSuggestUpgrade({ mindType: "mind", templateHash: "old" }, null), false);
  });
});
