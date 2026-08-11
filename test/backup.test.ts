import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  backupRoots,
  stageDatabases,
  stagingDir,
} from "../packages/daemon/src/lib/backup/backup.js";
import {
  buildExcludePatterns,
  resticVersion,
  writeExcludeFile,
} from "../packages/daemon/src/lib/backup/restic.js";
import { _resetConfigCache, secretsPath } from "../packages/daemon/src/lib/config/setup.js";
import { voluteHome, voluteSystemDir } from "../packages/daemon/src/lib/mind/registry.js";

describe("backup exclude patterns", () => {
  it("excludes dependency trees, caches, and session transcripts by default", () => {
    const patterns = buildExcludePatterns({});
    assert.ok(patterns.includes("node_modules"));
    assert.ok(patterns.includes("home/.cache"));
    assert.ok(patterns.includes("home/.claude/projects"));
    assert.ok(patterns.includes(".mind/codex/sessions"));
  });

  it("keeps mind-authored .local/hooks and .local/bin, excluding only toolchain subdirs", () => {
    const patterns = buildExcludePatterns({});
    assert.ok(
      !patterns.includes("home/.local"),
      "wholesale home/.local would drop mind hooks and skill shims",
    );
    assert.ok(patterns.includes("home/.local/share"));
    assert.ok(patterns.includes("home/.local/state"));
  });

  it("keeps session transcripts when includeSessions is set", () => {
    const patterns = buildExcludePatterns({ includeSessions: true });
    assert.ok(!patterns.includes("home/.claude/projects"));
    assert.ok(!patterns.includes(".mind/codex/sessions"));
    assert.ok(patterns.includes("node_modules"));
  });

  it("excludes live system DBs by absolute path, not bare name", () => {
    const patterns = buildExcludePatterns({});
    assert.ok(!patterns.includes("volute.db"), "bare volute.db would nuke the staged copy");
    assert.ok(patterns.includes(resolve(voluteSystemDir(), "volute.db")));
  });

  it("excludes a local repository so restic can't back up its repo into itself", () => {
    const repo = resolve(voluteSystemDir(), "e2e-restic-repo");
    const patterns = buildExcludePatterns({ repository: repo });
    assert.ok(
      patterns.includes(repo),
      "a local repo inside a backup root must be excluded to avoid racing restic's own pack files",
    );
  });

  it("does not add an exclude for a remote (non-local) repository backend", () => {
    const patterns = buildExcludePatterns({ repository: "s3:s3.amazonaws.com/my-bucket" });
    const base = buildExcludePatterns({});
    assert.deepEqual(patterns, base, "remote backends have nothing on the local tree to exclude");
  });

  it("writes the exclude file into the system dir", () => {
    const path = writeExcludeFile({});
    assert.ok(existsSync(path));
    assert.ok(readFileSync(path, "utf-8").includes("node_modules"));
  });
});

describe("backup staging", () => {
  it("VACUUM INTO produces an openable copy of the system DB", async () => {
    const staged = await stageDatabases();
    const mainCopy = resolve(stagingDir(), "volute.db");
    assert.ok(staged.includes(mainCopy));
    assert.ok(existsSync(mainCopy));
    // The copy must be a valid, independent SQLite DB.
    const { default: Database } = await import("libsql");
    const db = new Database(mainCopy);
    try {
      const row = db.prepare("SELECT count(*) AS n FROM sqlite_master").get() as { n: number };
      assert.ok(row.n >= 0);
    } finally {
      db.close();
    }
  });

  it("stages extension DBs mirroring their layout", async () => {
    const extDir = resolve(voluteSystemDir(), "extension-data", "testext");
    mkdirSync(extDir, { recursive: true });
    const { default: Database } = await import("libsql");
    const db = new Database(resolve(extDir, "data.db"));
    db.exec("CREATE TABLE IF NOT EXISTS t (x); INSERT INTO t VALUES (1)");
    db.close();
    try {
      await stageDatabases();
      const copy = resolve(stagingDir(), "extension-data", "testext", "data.db");
      assert.ok(existsSync(copy));
      const check = new Database(copy);
      try {
        const row = check.prepare("SELECT count(*) AS n FROM t").get() as { n: number };
        assert.equal(row.n, 1);
      } finally {
        check.close();
      }
    } finally {
      rmSync(extDir, { recursive: true, force: true });
    }
  });

  it("collects voluteHome as a backup root", async () => {
    const roots = await backupRoots();
    assert.ok(roots.includes(voluteHome()));
  });

  it("adds custom mind dirs outside the standard roots, without duplicating covered ones", async () => {
    const { addMind, removeMind } = await import("../packages/daemon/src/lib/mind/registry.js");
    const { getDb } = await import("../packages/daemon/src/lib/db.js");
    const { minds } = await import("../packages/daemon/src/lib/schema.js");
    const { eq } = await import("drizzle-orm");

    const customDir = resolve(voluteHome(), "..", "volute-custom-mind");
    mkdirSync(customDir, { recursive: true });
    const insideDir = resolve(voluteHome(), "minds", "inside-mind");
    mkdirSync(insideDir, { recursive: true });
    await addMind("custom-root-mind", 4497);
    await addMind("inside-root-mind", 4498);
    const db = await getDb();
    await db.update(minds).set({ dir: customDir }).where(eq(minds.name, "custom-root-mind"));
    await db.update(minds).set({ dir: insideDir }).where(eq(minds.name, "inside-root-mind"));
    try {
      const roots = await backupRoots();
      assert.ok(roots.includes(customDir), "custom dir outside voluteHome must be a root");
      assert.ok(!roots.includes(insideDir), "dir under voluteHome must not be duplicated");
    } finally {
      await removeMind("custom-root-mind");
      await removeMind("inside-root-mind");
      rmSync(customDir, { recursive: true, force: true });
      rmSync(insideDir, { recursive: true, force: true });
    }
  });
});

describe("runBackup failure bookkeeping", () => {
  afterEach(() => {
    _resetConfigCache();
    for (const f of ["config.json", "backup-state.json"]) {
      try {
        unlinkSync(resolve(voluteSystemDir(), f));
      } catch {}
    }
    try {
      unlinkSync(secretsPath());
    } catch {}
  });

  it("rejects before staging when unconfigured, records the failure, and releases the guard", async () => {
    const { runBackup, readBackupState } = await import(
      "../packages/daemon/src/lib/backup/backup.js"
    );
    await assert.rejects(runBackup(), /not configured/);
    const state = readBackupState();
    assert.ok(state.lastAttempt, "failed attempt is timestamped");
    assert.match(state.lastError ?? "", /not configured/);
    assert.equal(state.lastRun, undefined, "no success is recorded");
    // The in-flight guard must be released — not "already running".
    await assert.rejects(runBackup(), /not configured/);
  });
});

describe("restoreStagedDb", () => {
  const dir = resolve(voluteSystemDir(), "restore-test");

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("leaves the live DB untouched when the staged copy is missing", async () => {
    const { restoreStagedDb } = await import("../packages/daemon/src/lib/backup/backup.js");
    mkdirSync(dir, { recursive: true });
    const live = resolve(dir, "volute.db");
    writeFileSync(live, "live-data");
    assert.equal(restoreStagedDb(resolve(dir, "staged", "volute.db"), live), false);
    assert.equal(readFileSync(live, "utf-8"), "live-data", "live DB must not be deleted");
  });

  it("moves the staged copy into place, clearing stale WAL/SHM", async () => {
    const { restoreStagedDb } = await import("../packages/daemon/src/lib/backup/backup.js");
    mkdirSync(resolve(dir, "staged"), { recursive: true });
    const live = resolve(dir, "volute.db");
    writeFileSync(live, "old");
    writeFileSync(`${live}-wal`, "stale-wal");
    writeFileSync(`${live}-shm`, "stale-shm");
    writeFileSync(resolve(dir, "staged", "volute.db"), "restored");
    assert.equal(restoreStagedDb(resolve(dir, "staged", "volute.db"), live), true);
    assert.equal(readFileSync(live, "utf-8"), "restored");
    assert.ok(!existsSync(`${live}-wal`), "stale WAL would corrupt the restored DB");
    assert.ok(!existsSync(`${live}-shm`));
    assert.ok(!existsSync(resolve(dir, "staged", "volute.db")), "staged copy is moved, not copied");
  });
});

describe("backup API authorization", () => {
  afterEach(async () => {
    _resetConfigCache();
    try {
      unlinkSync(resolve(voluteSystemDir(), "config.json"));
    } catch {}
    try {
      unlinkSync(secretsPath());
    } catch {}
    const { getDb } = await import("../packages/daemon/src/lib/db.js");
    const { users } = await import("../packages/daemon/src/lib/schema.js");
    const { inArray } = await import("drizzle-orm");
    const db = await getDb();
    await db.delete(users).where(inArray(users.username, ["backup-admin", "backup-mind-test"]));
    const { removeMind } = await import("../packages/daemon/src/lib/mind/registry.js");
    try {
      await removeMind("backup-mind-test");
    } catch {}
  });

  async function makeApp() {
    const { Hono } = await import("hono");
    const { authMiddleware } = await import("../packages/daemon/src/web/middleware/auth.js");
    const { default: backupRoutes } = await import("../packages/daemon/src/web/api/backup.js");
    const app = new Hono();
    app.use("/api/v1/backup/*", authMiddleware);
    app.route("/api/v1/backup", backupRoutes);
    return app;
  }

  it("rejects a mind token on every backup route", async () => {
    const { addMind } = await import("../packages/daemon/src/lib/mind/registry.js");
    const { getOrCreateMindUser, createUser } = await import("../packages/daemon/src/lib/auth.js");
    const { generateMindToken } = await import("../packages/daemon/src/lib/daemon/mind-tokens.js");
    await createUser("backup-admin", "pass"); // first user becomes admin
    await addMind("backup-mind-test", 4499);
    await getOrCreateMindUser("backup-mind-test");
    const token = generateMindToken("backup-mind-test");
    const app = await makeApp();
    const headers = { Authorization: `Bearer ${token}` };

    for (const [method, path] of [
      ["GET", "/api/v1/backup/config"],
      ["PUT", "/api/v1/backup/config"],
      ["POST", "/api/v1/backup/init"],
      ["POST", "/api/v1/backup/run"],
      ["GET", "/api/v1/backup/snapshots"],
      ["GET", "/api/v1/backup/status"],
    ] as const) {
      const res = await app.request(path, { method, headers });
      assert.equal(res.status, 403, `${method} ${path} must be admin-only`);
    }
  });

  it("never returns the password or env values, even to admins", async () => {
    const { createUser } = await import("../packages/daemon/src/lib/auth.js");
    const { createSession } = await import("../packages/daemon/src/web/middleware/auth.js");
    const admin = await createUser("backup-admin", "pass");
    const sessionId = await createSession(admin.id);
    const app = await makeApp();
    const headers = {
      Cookie: `volute_session=${sessionId}`,
      "Content-Type": "application/json",
    };

    const put = await app.request("/api/v1/backup/config", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        repository: "/tmp/repo",
        password: "super-secret-passphrase",
        env: { AWS_SECRET_ACCESS_KEY: "aws-secret-value" },
      }),
    });
    assert.equal(put.status, 200);
    const putBody = JSON.stringify(await put.json());
    assert.ok(!putBody.includes("super-secret-passphrase"));
    assert.ok(!putBody.includes("aws-secret-value"));

    const get = await app.request("/api/v1/backup/config", { headers });
    const getBody = (await get.json()) as {
      hasPassword: boolean;
      envKeys: string[];
      repository: string;
    };
    assert.equal(get.status, 200);
    assert.equal(getBody.hasPassword, true);
    assert.deepEqual(getBody.envKeys, ["AWS_SECRET_ACCESS_KEY"]);
    assert.ok(!JSON.stringify(getBody).includes("super-secret-passphrase"));

    // Saving config without a password keeps the stored one; same for env.
    const put2 = await app.request("/api/v1/backup/config", {
      method: "PUT",
      headers,
      body: JSON.stringify({ repository: "/tmp/repo2", password: "" }),
    });
    assert.equal(put2.status, 200);
    _resetConfigCache();
    const { readGlobalConfig } = await import("../packages/daemon/src/lib/config/setup.js");
    assert.equal(readGlobalConfig().backup?.password, "super-secret-passphrase");
    assert.equal(readGlobalConfig().backup?.repository, "/tmp/repo2");
    assert.deepEqual(readGlobalConfig().backup?.env, { AWS_SECRET_ACCESS_KEY: "aws-secret-value" });
  });

  it("rejects an invalid cron schedule and all-zero retention", async () => {
    const { createUser } = await import("../packages/daemon/src/lib/auth.js");
    const { createSession } = await import("../packages/daemon/src/web/middleware/auth.js");
    const admin = await createUser("backup-admin", "pass");
    const sessionId = await createSession(admin.id);
    const app = await makeApp();
    const headers = {
      Cookie: `volute_session=${sessionId}`,
      "Content-Type": "application/json",
    };

    const badCron = await app.request("/api/v1/backup/config", {
      method: "PUT",
      headers,
      body: JSON.stringify({ schedule: "61 3 * * *" }),
    });
    assert.equal(badCron.status, 400, "a cron typo must not silently disable backups");

    const zeroKeep = await app.request("/api/v1/backup/config", {
      method: "PUT",
      headers,
      body: JSON.stringify({ keep: { daily: 0, weekly: 0, monthly: 0 } }),
    });
    assert.equal(zeroKeep.status, 400, "all-zero retention would prune every snapshot");

    const goodCron = await app.request("/api/v1/backup/config", {
      method: "PUT",
      headers,
      body: JSON.stringify({ schedule: "30 4 * * *" }),
    });
    assert.equal(goodCron.status, 200);
  });

  it("does not persist a generated passphrase when init fails", async () => {
    const { createUser } = await import("../packages/daemon/src/lib/auth.js");
    const { createSession } = await import("../packages/daemon/src/web/middleware/auth.js");
    const admin = await createUser("backup-admin", "pass");
    const sessionId = await createSession(admin.id);
    const app = await makeApp();
    const headers = {
      Cookie: `volute_session=${sessionId}`,
      "Content-Type": "application/json",
    };

    // Unreachable repo → init fails whether or not restic is installed.
    const put = await app.request("/api/v1/backup/config", {
      method: "PUT",
      headers,
      body: JSON.stringify({ repository: "s3:http://127.0.0.1:9/volute-test-nope" }),
    });
    assert.equal(put.status, 200);
    const init = await app.request("/api/v1/backup/init", { method: "POST", headers });
    assert.equal(init.status, 500);
    _resetConfigCache();
    const { readGlobalConfig } = await import("../packages/daemon/src/lib/config/setup.js");
    assert.equal(
      readGlobalConfig().backup?.password,
      undefined,
      "a passphrase the host never saw must not end up guarding the repository",
    );
  });
});

describe("backup manager scheduling", () => {
  function writeLastRun(iso: string): void {
    writeFileSync(
      resolve(voluteSystemDir(), "backup-state.json"),
      `${JSON.stringify({ lastRun: iso }, null, 2)}\n`,
    );
  }

  afterEach(() => {
    _resetConfigCache();
    for (const f of ["config.json", "backup-state.json"]) {
      try {
        unlinkSync(resolve(voluteSystemDir(), f));
      } catch {}
    }
    try {
      unlinkSync(secretsPath());
    } catch {}
  });

  it("is due only on the cron minute, once, and only when enabled + configured", async () => {
    const { BackupManager } = await import("../packages/daemon/src/lib/daemon/backup-manager.js");
    const { writeGlobalConfig } = await import("../packages/daemon/src/lib/config/setup.js");
    const mgr = new BackupManager();
    const at3am = new Date("2026-07-07T03:00:30");

    // Not configured → never due.
    assert.equal(mgr.isDue(at3am), false);

    writeGlobalConfig({
      backup: { repository: "/tmp/r", password: "p", enabled: true, schedule: "0 3 * * *" },
    });
    _resetConfigCache();
    assert.equal(mgr.isDue(new Date("2026-07-07T02:59:30")), false, "before the cron minute");
    assert.equal(mgr.isDue(at3am), true, "on the cron minute");
    assert.equal(mgr.isDue(at3am), false, "does not double-fire in the same minute");
    assert.equal(mgr.isDue(new Date("2026-07-08T03:00:10")), true, "fires again next day");

    // Disabled → not due even on the minute.
    writeGlobalConfig({
      backup: { repository: "/tmp/r", password: "p", enabled: false, schedule: "0 3 * * *" },
    });
    _resetConfigCache();
    assert.equal(mgr.isDue(new Date("2026-07-09T03:00:10")), false);
  });

  it("returns false without throwing on a malformed cron", async () => {
    const { BackupManager } = await import("../packages/daemon/src/lib/daemon/backup-manager.js");
    const { writeGlobalConfig } = await import("../packages/daemon/src/lib/config/setup.js");
    writeGlobalConfig({
      backup: { repository: "/tmp/r", password: "p", enabled: true, schedule: "not-a-cron" },
    });
    _resetConfigCache();
    const mgr = new BackupManager();
    assert.equal(mgr.isDue(new Date("2026-07-07T03:00:30")), false);
  });

  it("does not catch up without a prior successful run (fresh enable)", async () => {
    const { BackupManager } = await import("../packages/daemon/src/lib/daemon/backup-manager.js");
    const { writeGlobalConfig } = await import("../packages/daemon/src/lib/config/setup.js");
    writeGlobalConfig({
      backup: { repository: "/tmp/r", password: "p", enabled: true, schedule: "0 3 * * *" },
    });
    _resetConfigCache();
    const mgr = new BackupManager();
    // Well past 3am with no lastRun anchor → nothing to be behind on.
    assert.equal(mgr.isDue(new Date("2026-07-07T08:15:00")), false);
  });

  it("catches up on a fire missed while asleep, once, when it falls after lastRun", async () => {
    const { BackupManager } = await import("../packages/daemon/src/lib/daemon/backup-manager.js");
    const { writeGlobalConfig } = await import("../packages/daemon/src/lib/config/setup.js");
    writeGlobalConfig({
      backup: { repository: "/tmp/r", password: "p", enabled: true, schedule: "0 3 * * *" },
    });
    _resetConfigCache();
    // Last success was yesterday; today's 3am fire was missed (laptop asleep).
    // Anchor in local time so it lines up with the local-time cron and `now`.
    writeLastRun(new Date("2026-07-06T03:00:05").toISOString());
    const mgr = new BackupManager();
    // Daemon wakes at 08:15, well after the 03:00 fire it slept through.
    assert.equal(mgr.isDue(new Date("2026-07-07T08:15:00")), true, "catches up on the missed fire");
    assert.equal(
      mgr.isDue(new Date("2026-07-07T08:16:00")),
      false,
      "does not re-fire the same missed fire",
    );
  });

  it("does not catch up on a fire already covered by lastRun", async () => {
    const { BackupManager } = await import("../packages/daemon/src/lib/daemon/backup-manager.js");
    const { writeGlobalConfig } = await import("../packages/daemon/src/lib/config/setup.js");
    writeGlobalConfig({
      backup: { repository: "/tmp/r", password: "p", enabled: true, schedule: "0 3 * * *" },
    });
    _resetConfigCache();
    // Today's 3am fire already ran successfully (local-time anchor).
    writeLastRun(new Date("2026-07-07T03:00:04").toISOString());
    const mgr = new BackupManager();
    assert.equal(mgr.isDue(new Date("2026-07-07T08:15:00")), false);
  });

  it("notifies on the 1st failure and every Nth, resetting on success", async () => {
    const { BackupManager } = await import("../packages/daemon/src/lib/daemon/backup-manager.js");
    const { subscribe } = await import("../packages/daemon/src/lib/events/activity-events.js");
    const mgr = new BackupManager();

    const events: string[] = [];
    const unsubscribe = subscribe((e) => {
      if (e.type === "backup_failed") events.push(e.summary);
    });
    try {
      const err = new Error("repo unreachable");
      // 1st notifies; 2nd–4th are throttled; 5th notifies again.
      assert.equal(await mgr.recordFailure(err), true, "1st failure notifies");
      assert.equal(await mgr.recordFailure(err), false);
      assert.equal(await mgr.recordFailure(err), false);
      assert.equal(await mgr.recordFailure(err), false);
      assert.equal(await mgr.recordFailure(err), true, "5th consecutive failure notifies");
      assert.equal(events.length, 2, "one activity event per notification");

      // A success resets the streak, so the next failure is a fresh 1st.
      mgr.recordSuccess();
      assert.equal(await mgr.recordFailure(err), true, "1st failure after recovery notifies");
    } finally {
      unsubscribe();
    }
  });
});

// Round-trip against a real restic binary; skipped when restic is not on PATH.
describe("restic round-trip", async () => {
  const available = (await resticVersion()) !== null;

  afterEach(() => {
    _resetConfigCache();
    try {
      unlinkSync(resolve(voluteSystemDir(), "config.json"));
    } catch {}
    try {
      unlinkSync(secretsPath());
    } catch {}
  });

  it("backs up a volute tree with exclusions and restores the kept files", async (t) => {
    if (!available) return t.skip("restic not installed");
    const { runBackup, listSnapshots, initRepo } = await import(
      "../packages/daemon/src/lib/backup/backup.js"
    );
    const { writeGlobalConfig } = await import("../packages/daemon/src/lib/config/setup.js");

    // Fabricate a mind tree inside the (test-isolated) volute home.
    const home = voluteHome();
    const mindDir = resolve(home, "minds", "testmind");
    mkdirSync(resolve(mindDir, "home", "memory"), { recursive: true });
    mkdirSync(resolve(mindDir, "node_modules", "leftpad"), { recursive: true });
    mkdirSync(resolve(mindDir, "home", ".claude", "projects", "sess"), { recursive: true });
    mkdirSync(resolve(mindDir, ".mind", "identity"), { recursive: true });
    mkdirSync(resolve(mindDir, "home", ".local", "hooks", "startup"), { recursive: true });
    mkdirSync(resolve(mindDir, "home", ".local", "share", "sometool"), { recursive: true });
    writeFileSync(resolve(mindDir, "home", "SOUL.md"), "# soul\n");
    writeFileSync(resolve(mindDir, "home", "memory", "note.md"), "remember\n");
    writeFileSync(resolve(mindDir, "node_modules", "leftpad", "index.js"), "x");
    writeFileSync(resolve(mindDir, "home", ".claude", "projects", "sess", "a.jsonl"), "{}");
    writeFileSync(resolve(mindDir, ".mind", "identity", "public.pem"), "pubkey\n");
    writeFileSync(
      resolve(mindDir, "home", ".local", "hooks", "startup", "custom.sh"),
      "#!/bin/sh\n",
    );
    writeFileSync(resolve(mindDir, "home", ".local", "share", "sometool", "cache.bin"), "blob");

    const repo = resolve(home, "test-restic-repo");
    const backupConfig = { repository: repo, password: "test-passphrase" };
    writeGlobalConfig({ backup: backupConfig });

    await initRepo(backupConfig);
    await initRepo(backupConfig); // idempotent
    const summary = await runBackup();
    assert.ok(summary.snapshotId);
    assert.ok(summary.totalFilesProcessed > 0);

    const snapshots = await listSnapshots();
    assert.equal(snapshots.length, 1);

    // Verify exclusions via restic ls.
    const env = {
      ...process.env,
      RESTIC_REPOSITORY: repo,
      RESTIC_PASSWORD: "test-passphrase",
    };
    const listing = execFileSync("restic", ["ls", "latest"], { env, encoding: "utf-8" });
    assert.ok(listing.includes("SOUL.md"), "kept files present");
    assert.ok(listing.includes("note.md"), "memory present");
    assert.ok(listing.includes("public.pem"), "identity present");
    assert.ok(listing.includes("backup-staging/volute.db"), "staged DB present");
    assert.ok(listing.includes(".local/hooks/startup/custom.sh"), "mind-authored hooks kept");
    assert.ok(!listing.includes(".local/share"), "toolchain subdirs excluded");
    assert.ok(!listing.includes("node_modules"), "node_modules excluded");
    assert.ok(!listing.includes(".claude/projects"), "session transcripts excluded");
    assert.ok(!/\bvolute\.db-wal\b/.test(listing), "live WAL excluded");

    // Restore to a target and check contents round-trip.
    const target = resolve(home, "restore-target");
    execFileSync("restic", ["restore", "latest", "--target", target], { env });
    const restoredSoul = resolve(target, mindDir.slice(1), "home", "SOUL.md");
    assert.equal(readFileSync(restoredSoul, "utf-8"), "# soul\n");
    assert.ok(
      !existsSync(resolve(target, mindDir.slice(1), "node_modules")),
      "excluded paths not restored",
    );
  });
});
