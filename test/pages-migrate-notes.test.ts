/**
 * Tests for the notes → pages migration.
 *
 * The migration is the only irreversible thing in the merge, so these tests are
 * weighted towards the two properties that cannot be fixed after the fact:
 * attribution and timestamps.
 *
 * The fixture mirrors the shape measured on the production host in issue #807 —
 * 24 notes, 5 comments, 6 reactions, with notes #1 and #2 recorded against a
 * human user when they are actually whorl's work.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Database as ExtDb, ExtensionContext, User } from "@volute/extensions";
import Database from "libsql";

import { getPage, initDb } from "../packages/extensions/pages/src/db.js";
import {
  applyMigration,
  formatPlan,
  parseReassignments,
  planMigration,
} from "../packages/extensions/pages/src/migrate-notes.js";
import { getComments, getReactions } from "../packages/extensions/pages/src/social.js";

let pagesDb: ExtDb;
let notesDb: ExtDb;
let root: string;
let dataDir: string;
const users = new Map<number, User>();
const mindDirs = new Map<string, string>();

/** Author ids as they appear in the fixture. */
const PSAMITON = 1; // a human — has no pages directory
const MIMSY = 2;
const GARDENER = 3;
const PIP = 4;
const WHORL = 5;

function addUser(id: number, username: string, type: User["user_type"]): void {
  users.set(id, {
    id,
    username,
    role: type === "human" ? "admin" : "user",
    user_type: type,
    display_name: null,
    description: null,
    avatar: null,
  });
}

function addMind(name: string): void {
  const dir = resolve(root, "minds", name);
  mkdirSync(resolve(dir, "home", "pages"), { recursive: true });
  mindDirs.set(name, dir);
}

function initNotesDb(db: ExtDb): void {
  db.exec(`
    CREATE TABLE notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      author_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      slug TEXT NOT NULL,
      content TEXT NOT NULL,
      reply_to_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE note_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL,
      author_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE note_reactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      emoji TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function insertNote(
  id: number,
  authorId: number,
  title: string,
  slug: string,
  content: string,
  createdAt: string,
): void {
  notesDb
    .prepare(
      "INSERT INTO notes (id, author_id, title, slug, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, authorId, title, slug, content, createdAt, createdAt);
}

/**
 * The production shape from #807: 24 notes across five actors, with the first two
 * misattributed. Per-author counts: psamiton 2 (really whorl's), mimsy 13,
 * gardener 5, pip 3, whorl 1 — 24 total.
 */
function seedProductionShape(): void {
  insertNote(1, PSAMITON, "A first note", "a-first-note", "body one", "2026-03-04 09:00:00");
  insertNote(
    2,
    PSAMITON,
    "Correction: The Note Above Is Mine",
    "correction-the-note-above-is-mine",
    "The note above is mine, not psamiton's.",
    "2026-03-04 09:05:00",
  );
  for (let i = 0; i < 13; i++) {
    insertNote(10 + i, MIMSY, `Mimsy ${i}`, `mimsy-${i}`, `m${i}`, `2026-03-1${i % 10} 10:00:00`);
  }
  for (let i = 0; i < 5; i++) {
    insertNote(
      30 + i,
      GARDENER,
      `Essay ${i}`,
      `essay-${i}`,
      "x".repeat(120),
      "2026-04-01 10:00:00",
    );
  }
  for (let i = 0; i < 3; i++) {
    insertNote(50 + i, PIP, `Pip ${i}`, `pip-${i}`, `p${i}`, "2026-07-03 10:00:00");
  }
  insertNote(70, WHORL, "Whorl's own", "whorls-own", "w", "2026-05-01 10:00:00");

  // 5 comments, 4 of them pip's letters to specific minds.
  const comments: [number, number, string, string][] = [
    [10, PIP, "a letter to mimsy", "2026-07-03 12:00:00"],
    [30, PIP, "a letter to gardener", "2026-07-18 20:01:01"],
    [70, PIP, "a letter to whorl", "2026-07-03 12:10:00"],
    [11, PIP, "another for mimsy", "2026-07-03 12:20:00"],
    [50, MIMSY, "a reply on pip's note", "2026-07-04 09:00:00"],
  ];
  for (const [noteId, authorId, content, createdAt] of comments) {
    notesDb
      .prepare(
        "INSERT INTO note_comments (note_id, author_id, content, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(noteId, authorId, content, createdAt);
  }

  const reactions: [number, number, string][] = [
    [10, PIP, "🌱"],
    [11, PIP, "✨"],
    [30, PIP, "🌱"],
    [70, PIP, "✨"],
    [50, MIMSY, "🌱"],
    [51, GARDENER, "🌱"],
  ];
  for (const [noteId, userId, emoji] of reactions) {
    notesDb
      .prepare(
        "INSERT INTO note_reactions (note_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(noteId, userId, emoji, "2026-07-03 12:00:00");
  }
}

function ctx(): ExtensionContext {
  return {
    db: pagesDb,
    dataDir,
    authMiddleware: (async (_c: unknown, next: () => Promise<void>) => next()) as never,
    requireSelf: () => (async (_c: unknown, next: () => Promise<void>) => next()) as never,
    resolveUser: () => null,
    getUser: async (id: number) => users.get(id) ?? null,
    getUserByUsername: async (username: string) =>
      [...users.values()].find((u) => u.username === username) ?? null,
    publishActivity: () => {},
    getMindDir: async (name: string) => mindDirs.get(name) ?? null,
    getSystemsConfig: () => null,
    announceToCommons: async () => {},
    recordNotice: async () => {},
    isIsolationEnabled: () => false,
    getMindUser: (name: string) => `mind-${name}`,
    getSpiritName: () => "volute",
  };
}

describe("notes → pages migration", () => {
  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), "pages-migrate-"));
    dataDir = resolve(root, "data");
    mkdirSync(dataDir, { recursive: true });

    pagesDb = new Database(":memory:") as unknown as ExtDb;
    initDb(pagesDb);
    notesDb = new Database(":memory:") as unknown as ExtDb;
    initNotesDb(notesDb);

    users.clear();
    mindDirs.clear();
    addUser(PSAMITON, "psamiton", "human");
    addUser(MIMSY, "mimsy", "mind");
    addUser(GARDENER, "gardener", "mind");
    addUser(PIP, "pip", "mind");
    addUser(WHORL, "whorl", "mind");
    for (const name of ["mimsy", "gardener", "pip", "whorl"]) addMind(name);

    seedProductionShape();
  });

  afterEach(() => {
    pagesDb.close();
    notesDb.close();
    rmSync(root, { recursive: true, force: true });
  });

  describe("dry run", () => {
    it("reconciles against the known production totals", async () => {
      const plan = await planMigration(notesDb, ctx());
      assert.equal(plan.totals.notes, 24);
      assert.equal(plan.totals.comments, 5);
      assert.equal(plan.totals.reactions, 6);
    });

    it("reports the per-author breakdown from issue #807", async () => {
      const plan = await planMigration(notesDb, ctx());
      const counts = Object.fromEntries(plan.byAuthor.map((a) => [a.author, a.notes]));
      assert.deepEqual(counts, { mimsy: 13, gardener: 5, pip: 3, psamiton: 2, whorl: 1 });
    });

    it("writes nothing", async () => {
      await planMigration(notesDb, ctx());
      assert.equal(
        existsSync(resolve(mindDirs.get("mimsy") as string, "home", "pages", "notes")),
        false,
        "a dry run touches no files",
      );
      const rows = pagesDb.prepare("SELECT COUNT(*) AS n FROM published_pages").get() as {
        n: number;
      };
      assert.equal(rows.n, 0, "and writes no rows");
    });

    it("names the misattributed notes as blocked rather than placing them", async () => {
      const plan = await planMigration(notesDb, ctx());
      const blocked = plan.entries.filter((e) => e.status === "blocked");
      assert.deepEqual(
        blocked.map((e) => e.noteId),
        [1, 2],
        "the two notes recorded against a human are the only blocked ones",
      );
      assert.match(blocked[0].reason ?? "", /not a mind with a pages directory/);
      assert.match(blocked[0].reason ?? "", /--reassign 1=<mind>/);
    });

    it("prints the mapping with the resolved author for every note", async () => {
      const plan = await planMigration(notesDb, ctx());
      const report = formatPlan(plan, { applied: false });
      assert.match(report, /DRY RUN — nothing was written/);
      assert.match(report, /mimsy\/notes\/mimsy-0\.md/);
      assert.match(report, /Re-run with --apply/);
      assert.match(report, /BLOCKED/);
    });
  });

  describe("attribution repair", () => {
    it("parses reassignments", () => {
      assert.deepEqual(
        [...parseReassignments(["1=whorl", "2=whorl"]).entries()],
        [
          [1, "whorl"],
          [2, "whorl"],
        ],
      );
      assert.throws(() => parseReassignments(["nonsense"]), /Invalid --reassign/);
      assert.throws(() => parseReassignments(["1="]), /Invalid --reassign/);
    });

    it("routes a reassigned note to the mind that actually wrote it", async () => {
      const reassign = parseReassignments(["1=whorl", "2=whorl"]);
      const plan = await planMigration(notesDb, ctx(), { reassign });

      assert.equal(plan.totals.blocked, 0);
      const first = plan.entries.find((e) => e.noteId === 1);
      assert.ok(first);
      assert.equal(first.recordedAuthor, "psamiton");
      assert.equal(first.resolvedAuthor, "whorl");
      assert.equal(first.reassigned, true);
      assert.deepEqual(first.target, { mind: "whorl", file: "notes/a-first-note.md" });
    });

    it("shows the repair in the report rather than performing it silently", async () => {
      const plan = await planMigration(notesDb, ctx(), {
        reassign: parseReassignments(["1=whorl"]),
      });
      assert.match(formatPlan(plan, { applied: false }), /psamiton → whorl \(REASSIGNED\)/);
    });

    it("refuses to apply while anything is blocked", async () => {
      const plan = await planMigration(notesDb, ctx());
      await assert.rejects(
        () => applyMigration(notesDb, ctx(), plan),
        /blocked.*Nothing was written/s,
      );
      const rows = pagesDb.prepare("SELECT COUNT(*) AS n FROM published_pages").get() as {
        n: number;
      };
      assert.equal(rows.n, 0, "the refusal is total, not partial");
    });

    it("can be told explicitly to leave blocked notes behind", async () => {
      const plan = await planMigration(notesDb, ctx());
      const result = await applyMigration(notesDb, ctx(), plan, { skipBlocked: true });
      assert.equal(result.migrated, 22);
      assert.equal(result.skipped, 2);
    });
  });

  describe("apply", () => {
    async function runFullMigration() {
      const reassign = parseReassignments(["1=whorl", "2=whorl"]);
      const plan = await planMigration(notesDb, ctx(), { reassign });
      return applyMigration(notesDb, ctx(), plan);
    }

    it("migrates every note to a markdown file in its author's pages space", async () => {
      const result = await runFullMigration();
      assert.equal(result.migrated, 24);

      const mimsyPage = resolve(
        mindDirs.get("mimsy") as string,
        "home",
        "pages",
        "notes",
        "mimsy-0.md",
      );
      assert.ok(existsSync(mimsyPage));
      const body = readFileSync(mimsyPage, "utf-8");
      assert.match(body, /^---\ntitle: "Mimsy 0"\n---\n/);
      assert.match(body, /m0/);
    });

    it("writes the repaired note into whorl's space, never psamiton's", async () => {
      await runFullMigration();
      const whorlDir = mindDirs.get("whorl") as string;
      assert.ok(existsSync(resolve(whorlDir, "home", "pages", "notes", "a-first-note.md")));
      assert.ok(
        existsSync(
          resolve(whorlDir, "home", "pages", "notes", "correction-the-note-above-is-mine.md"),
        ),
      );
      assert.equal(getPage(pagesDb, "whorl", "notes/a-first-note.md")?.mind, "whorl");
      assert.equal(getPage(pagesDb, "psamiton", "notes/a-first-note.md"), null);
    });

    it("preserves created_at rather than resetting it to migration day", async () => {
      await runFullMigration();
      const page = getPage(pagesDb, "whorl", "notes/a-first-note.md");
      assert.equal(page?.published_at, "2026-03-04 09:00:00");
      assert.equal(page?.updated_at, "2026-03-04 09:00:00");
    });

    it("re-keys comments onto page identity, preserving their timestamps", async () => {
      await runFullMigration();
      const comments = await getComments(pagesDb, ctx().getUser, {
        mind: "gardener",
        file: "notes/essay-0.md",
      });
      assert.equal(comments.length, 1);
      assert.equal(comments[0].content, "a letter to gardener");
      assert.equal(comments[0].created_at, "2026-07-18 20:01:01");
      assert.equal(comments[0].author_username, "pip");
    });

    it("leaves migrated comments with no recorded version, because Notes recorded none", async () => {
      await runFullMigration();
      const comments = await getComments(pagesDb, ctx().getUser, {
        mind: "gardener",
        file: "notes/essay-0.md",
      });
      assert.equal(comments[0].page_hash, null);
      assert.equal(comments[0].stale, false);
    });

    it("re-keys reactions onto page identity", async () => {
      await runFullMigration();
      const reactions = await getReactions(pagesDb, ctx().getUser, {
        mind: "mimsy",
        file: "notes/mimsy-0.md",
      });
      assert.deepEqual(reactions, [{ emoji: "🌱", count: 1, usernames: ["pip"] }]);
    });

    it("moves every comment and reaction across, none dropped", async () => {
      const result = await runFullMigration();
      assert.equal(result.comments, 5);
      assert.equal(result.reactions, 6);
    });

    it("publishes the page to the served snapshot, not only to the mind's directory", async () => {
      await runFullMigration();
      assert.ok(existsSync(resolve(dataDir, "sites", "mimsy", "notes", "mimsy-0.md")));
    });

    it("is idempotent — a second run changes nothing", async () => {
      await runFullMigration();
      const first = pagesDb.prepare("SELECT COUNT(*) AS n FROM page_comments").get() as {
        n: number;
      };

      const reassign = parseReassignments(["1=whorl", "2=whorl"]);
      const plan = await planMigration(notesDb, ctx(), { reassign });
      assert.equal(plan.totals.migrate, 0);
      assert.equal(plan.totals.alreadyMigrated, 24);

      const second = await applyMigration(notesDb, ctx(), plan);
      assert.equal(second.migrated, 0);
      assert.equal(second.comments, 0);

      const after = pagesDb.prepare("SELECT COUNT(*) AS n FROM page_comments").get() as {
        n: number;
      };
      assert.equal(after.n, first.n, "no duplicated comments");
    });
  });

  describe("collisions", () => {
    it("refuses to overwrite a page the mind already wrote by hand", async () => {
      const dir = resolve(mindDirs.get("mimsy") as string, "home", "pages", "notes");
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, "mimsy-0.md"), "a page mimsy wrote herself");

      const plan = await planMigration(notesDb, ctx());
      const entry = plan.entries.find((e) => e.noteId === 10);
      assert.equal(entry?.status, "blocked");
      assert.match(entry?.reason ?? "", /already exists on disk/);
    });

    it("refuses a target that is a deleted page still holding a thread", async () => {
      // gardener's essay-0 was published, commented on, then deleted — the row
      // survives as a tombstone. A migrated note must not revive it and inherit
      // someone else's conversation.
      pagesDb
        .prepare(
          `INSERT INTO published_pages (mind, file, hash, deleted_at)
           VALUES ('gardener', 'notes/essay-0.md', 'h1', datetime('now'))`,
        )
        .run();
      pagesDb
        .prepare("INSERT INTO page_comments (mind, file, author_id, content) VALUES (?, ?, ?, ?)")
        .run("gardener", "notes/essay-0.md", PIP, "a letter about the old page");

      const plan = await planMigration(notesDb, ctx());
      const entry = plan.entries.find((e) => e.noteId === 30);
      assert.equal(entry?.status, "blocked");
      assert.match(entry?.reason ?? "", /deleted page whose comment thread is still attached/);
    });

    it("blocks two notes reassigned onto the same target", async () => {
      // Both misattributed notes reassigned to whorl is fine (distinct slugs);
      // routing a mimsy note onto an identical whorl slug is not.
      insertNote(90, MIMSY, "Whorl's own", "whorls-own", "clash", "2026-06-01 10:00:00");
      const plan = await planMigration(notesDb, ctx(), {
        reassign: parseReassignments(["90=whorl"]),
      });
      const clash = plan.entries.find((e) => e.noteId === 90);
      assert.equal(clash?.status, "blocked");
      assert.match(clash?.reason ?? "", /already claimed by note #70/);
    });
  });
});
