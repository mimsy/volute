import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, describe, it } from "node:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

// Data-preservation test for the #493 rename migrations. The regular test suite
// only ever applies migrations to fresh empty databases; this one populates a
// scratch DB with pre-rename rows (via migrations 0000–0013), then applies
// 0014 (session→thread column renames) and 0015 (brain→human user_type) and
// asserts the data survives under the new names.

const MIGRATIONS_DIR = resolve(import.meta.dirname, "../drizzle");
const CUTOFF_TAG = "0014_rename_session_to_thread";

type JournalEntry = { idx: number; tag: string } & Record<string, unknown>;
type Journal = { entries: JournalEntry[] } & Record<string, unknown>;

/** Copy the real migrations folder, truncating the journal to entries before `beforeTag`. */
function migrationsSubset(dest: string, beforeTag: string | null): void {
  rmSync(dest, { recursive: true, force: true });
  cpSync(MIGRATIONS_DIR, dest, { recursive: true });
  if (beforeTag == null) return;
  const journalPath = resolve(dest, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf-8")) as Journal;
  const cutoff = journal.entries.findIndex((e) => e.tag === beforeTag);
  assert.ok(cutoff > 0, `journal must contain ${beforeTag}`);
  journal.entries = journal.entries.slice(0, cutoff);
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
}

describe("rename migrations preserve data (0014 session→thread, 0015 brain→human)", () => {
  const scratch = mkdtempSync(resolve(tmpdir(), "volute-migration-test-"));
  after(() => rmSync(scratch, { recursive: true, force: true }));

  it("migrates populated tables in place", async () => {
    const db = drizzle({ connection: { url: `file:${resolve(scratch, "test.db")}` } });

    // 1. Apply everything BEFORE the rename, so the schema still has `session`
    //    columns and the users table still defaults to "brain"-era values.
    const preDir = resolve(scratch, "migrations-pre");
    mkdirSync(preDir, { recursive: true });
    migrationsSubset(preDir, CUTOFF_TAG);
    await migrate(db, { migrationsFolder: preDir });

    // 2. Insert legacy-shaped rows.
    await db.run(
      sql.raw(
        `INSERT INTO turns (id, mind, session, status) VALUES ('t1', 'echo', 'main', 'complete')`,
      ),
    );
    await db.run(
      sql.raw(
        `INSERT INTO mind_history (mind, channel, session, type, content) VALUES ('echo', '@alice', '@alice', 'inbound', 'hello')`,
      ),
    );
    // A pending delivery_queue row — exactly what a live system would have
    // in flight across the upgrade.
    await db.run(
      sql.raw(
        `INSERT INTO delivery_queue (mind, session, channel, status, payload) VALUES ('echo', 'discord', 'discord:general', 'pending', '{}')`,
      ),
    );
    await db.run(
      sql.raw(
        `INSERT INTO users (username, password_hash, role, user_type) VALUES ('alice', '!x', 'admin', 'brain')`,
      ),
    );
    await db.run(
      sql.raw(
        `INSERT INTO users (username, password_hash, role, user_type) VALUES ('echo', '!x', 'user', 'mind')`,
      ),
    );

    // 3. Apply the rename migrations (0014, 0015) on top.
    const fullDir = resolve(scratch, "migrations-full");
    mkdirSync(fullDir, { recursive: true });
    migrationsSubset(fullDir, null);
    await migrate(db, { migrationsFolder: fullDir });

    // 4. Data survives under the new column name / value.
    const turn = (await db.all(sql.raw(`SELECT * FROM turns WHERE id = 't1'`)))[0] as Record<
      string,
      unknown
    >;
    assert.equal(turn.thread, "main");
    assert.ok(!("session" in turn), "turns must not keep a session column");

    const hist = (
      await db.all(sql.raw(`SELECT * FROM mind_history WHERE mind = 'echo'`))
    )[0] as Record<string, unknown>;
    assert.equal(hist.thread, "@alice");
    assert.ok(!("session" in hist), "mind_history must not keep a session column");

    const dq = (
      await db.all(sql.raw(`SELECT * FROM delivery_queue WHERE mind = 'echo'`))
    )[0] as Record<string, unknown>;
    assert.equal(dq.thread, "discord");
    assert.equal(dq.status, "pending", "in-flight delivery must survive the rename");
    assert.ok(!("session" in dq), "delivery_queue must not keep a session column");

    const userTypes = (await db.all(
      sql.raw(`SELECT username, user_type FROM users ORDER BY username`),
    )) as { username: string; user_type: string }[];
    assert.deepEqual(
      userTypes.map((u) => `${u.username}:${u.user_type}`),
      ["alice:human", "echo:mind"],
      "brain users become human; mind users are untouched",
    );

    // 5. The renamed indexes were recreated.
    const indexes = (await db.all(
      sql.raw(`SELECT name FROM sqlite_master WHERE type = 'index'`),
    )) as { name: string }[];
    const names = new Set(indexes.map((i) => i.name));
    assert.ok(names.has("idx_mind_history_thread"), "mind_history thread index exists");
    assert.ok(names.has("idx_delivery_queue_mind_thread"), "delivery_queue thread index exists");
    assert.ok(!names.has("idx_mind_history_session"), "old mind_history index dropped");
    assert.ok(!names.has("idx_delivery_queue_mind_session"), "old delivery_queue index dropped");
  });
});
