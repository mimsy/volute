import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Database as ExtDb, ExtensionContext, User } from "@volute/extensions";
import Database from "libsql";

import {
  getAllSites,
  getPage,
  getPublishedPages,
  getRecentPages,
  initDb,
  syncPublishedPages,
} from "../packages/extensions/pages/src/db.js";
import {
  allocateQuickPath,
  slugify,
  writeQuickPage,
} from "../packages/extensions/pages/src/publish.js";
import {
  addComment,
  deleteComment,
  getComments,
  getReactions,
  getThread,
  parsePageRef,
  resolvePageRef,
  toggleReaction,
} from "../packages/extensions/pages/src/social.js";

let db: ExtDb;
const users = new Map<number, User>();

function registerUser(id: number, username: string): User {
  const user: User = {
    id,
    username,
    role: "user",
    user_type: "mind",
    display_name: null,
    description: null,
    avatar: null,
  };
  users.set(id, user);
  return user;
}

async function getUser(id: number): Promise<User | null> {
  return users.get(id) ?? null;
}

/** Publish a page with a known hash, the way a real publish would. */
function publish(mind: string, file: string, hash: string): void {
  syncPublishedPages(db, mind, [{ file, hash }]);
}

describe("pages social layer", () => {
  beforeEach(() => {
    db = new Database(":memory:") as unknown as ExtDb;
    initDb(db);
    users.clear();
    registerUser(1, "mimsy");
    registerUser(2, "pip");
  });
  afterEach(() => db.close());

  describe("page references", () => {
    it("splits on the first slash so file paths keep their own slashes", () => {
      assert.deepEqual(parsePageRef("whorl/notes/tide.md"), {
        mind: "whorl",
        file: "notes/tide.md",
      });
    });

    it("rejects references that could climb out of a site", () => {
      assert.equal(parsePageRef("whorl/../secrets.md"), null);
      assert.equal(parsePageRef("whorl/notes/../../x.md"), null);
      assert.equal(parsePageRef("whorl/"), null);
      assert.equal(parsePageRef("/notes/x.md"), null);
      assert.equal(parsePageRef("no-slash"), null);
    });

    it("resolves the quick path's shorthand when it is unambiguous", () => {
      publish("mimsy", "notes/tideline.md", "h1");
      const found = resolvePageRef(db, { mind: "mimsy", file: "tideline" });
      assert.deepEqual(found, { file: "notes/tideline.md" });
    });

    it("offers candidates rather than guessing when a shorthand is ambiguous", () => {
      syncPublishedPages(db, "mimsy", [
        { file: "notes/tide.md", hash: "h1" },
        { file: "essays/tide.md", hash: "h2" },
      ]);
      const found = resolvePageRef(db, { mind: "mimsy", file: "tide" });
      assert.ok("candidates" in found);
      assert.deepEqual(found.candidates.sort(), ["essays/tide.md", "notes/tide.md"]);
    });
  });

  describe("comments carry the version they were written against", () => {
    it("snapshots the page hash at the time of writing", async () => {
      publish("mimsy", "notes/a.md", "hash-v1");
      const c = await addComment(db, getUser, { mind: "mimsy", file: "notes/a.md" }, 2, "hello");
      assert.equal(c.page_hash, "hash-v1");
      assert.equal(c.stale, false);
      assert.equal(c.author_username, "pip");
    });

    it("reads as stale once the page changes underneath it", async () => {
      publish("mimsy", "notes/a.md", "hash-v1");
      await addComment(db, getUser, { mind: "mimsy", file: "notes/a.md" }, 2, "on v1");
      publish("mimsy", "notes/a.md", "hash-v2");
      await addComment(db, getUser, { mind: "mimsy", file: "notes/a.md" }, 2, "on v2");

      const comments = await getComments(db, getUser, { mind: "mimsy", file: "notes/a.md" });
      assert.equal(comments.length, 2);
      assert.equal(comments[0].stale, true, "the v1 comment predates the edit");
      assert.equal(comments[1].stale, false, "the v2 comment is current");
    });

    it("never claims staleness it cannot know", async () => {
      // A comment with no recorded hash (e.g. migrated from Notes, which never
      // recorded one) is reported as not-stale rather than guessed at.
      publish("mimsy", "notes/a.md", "hash-v1");
      db.prepare(
        "INSERT INTO page_comments (mind, file, author_id, content, page_hash) VALUES (?, ?, ?, ?, NULL)",
      ).run("mimsy", "notes/a.md", 2, "migrated");
      const comments = await getComments(db, getUser, { mind: "mimsy", file: "notes/a.md" });
      assert.equal(comments[0].page_hash, null);
      assert.equal(comments[0].stale, false);
    });
  });

  describe("reactions", () => {
    it("toggles and is unique per (page, user, emoji)", async () => {
      publish("mimsy", "notes/a.md", "h1");
      const ref = { mind: "mimsy", file: "notes/a.md" };
      assert.deepEqual(toggleReaction(db, ref, 2, "🌱"), { added: true });
      assert.deepEqual(toggleReaction(db, ref, 2, "🌱"), { added: false });
      assert.deepEqual(toggleReaction(db, ref, 2, "🌱"), { added: true });

      toggleReaction(db, ref, 1, "🌱");
      const reactions = await getReactions(db, getUser, ref);
      assert.equal(reactions.length, 1);
      assert.equal(reactions[0].count, 2);
      assert.deepEqual(reactions[0].usernames.sort(), ["mimsy", "pip"]);
    });

    it("keys reactions to the page, not to the whole site", async () => {
      syncPublishedPages(db, "mimsy", [
        { file: "notes/a.md", hash: "h1" },
        { file: "notes/b.md", hash: "h2" },
      ]);
      toggleReaction(db, { mind: "mimsy", file: "notes/a.md" }, 2, "🌱");
      const onB = await getReactions(db, getUser, { mind: "mimsy", file: "notes/b.md" });
      assert.deepEqual(onB, []);
    });
  });

  describe("deletion leaves a tombstone", () => {
    it("keeps the thread standing when a page with comments is removed", async () => {
      publish("mimsy", "notes/a.md", "h1");
      await addComment(db, getUser, { mind: "mimsy", file: "notes/a.md" }, 2, "a letter");

      // Republish the site without that file — i.e. the mind deleted it.
      syncPublishedPages(db, "mimsy", []);

      const page = getPage(db, "mimsy", "notes/a.md");
      assert.ok(page, "the row survives as a tombstone");
      assert.ok(page.deleted_at, "and is marked deleted");

      const thread = await getThread(db, getUser, { mind: "mimsy", file: "notes/a.md" });
      assert.ok(thread.deleted_at);
      assert.equal(thread.comments.length, 1, "the conversation did not cascade away");
      assert.equal(thread.comments[0].content, "a letter");
    });

    it("keeps the thread when the only response was a reaction", async () => {
      publish("mimsy", "notes/a.md", "h1");
      toggleReaction(db, { mind: "mimsy", file: "notes/a.md" }, 2, "🌱");
      syncPublishedPages(db, "mimsy", []);
      assert.ok(getPage(db, "mimsy", "notes/a.md")?.deleted_at);
    });

    it("hard-deletes a page nobody ever responded to", () => {
      publish("mimsy", "notes/a.md", "h1");
      syncPublishedPages(db, "mimsy", []);
      assert.equal(getPage(db, "mimsy", "notes/a.md"), null);
    });

    it("hides tombstones from listings", async () => {
      publish("mimsy", "notes/a.md", "h1");
      await addComment(db, getUser, { mind: "mimsy", file: "notes/a.md" }, 2, "x");
      syncPublishedPages(db, "mimsy", []);
      assert.deepEqual(getPublishedPages(db, "mimsy"), []);
      assert.deepEqual(getRecentPages(db), []);
      assert.deepEqual(getAllSites(db), []);
    });

    it("revives the page and reattaches its thread when republished", async () => {
      publish("mimsy", "notes/a.md", "h1");
      await addComment(db, getUser, { mind: "mimsy", file: "notes/a.md" }, 2, "a letter");
      syncPublishedPages(db, "mimsy", []);

      const diff = syncPublishedPages(db, "mimsy", [{ file: "notes/a.md", hash: "h2" }]);
      assert.deepEqual(diff.added, ["notes/a.md"]);

      const page = getPage(db, "mimsy", "notes/a.md");
      assert.equal(page?.deleted_at, null);
      const thread = await getThread(db, getUser, { mind: "mimsy", file: "notes/a.md" });
      assert.equal(thread.comments.length, 1);
      assert.equal(thread.comments[0].stale, true, "the comment predates the new version");
    });
  });

  describe("comment moderation", () => {
    it("lets the page owner, the comment author, and admins delete; nobody else", async () => {
      publish("mimsy", "notes/a.md", "h1");
      const ref = { mind: "mimsy", file: "notes/a.md" };

      const byPip = await addComment(db, getUser, ref, 2, "one");
      assert.equal(
        deleteComment(db, byPip.id, { id: 99, username: "gardener" }),
        false,
        "a bystander cannot delete",
      );
      assert.equal(deleteComment(db, byPip.id, { id: 2, username: "pip" }), true);

      const again = await addComment(db, getUser, ref, 2, "two");
      assert.equal(
        deleteComment(db, again.id, { id: 1, username: "mimsy" }),
        true,
        "the page owner can moderate their own shelf",
      );

      const third = await addComment(db, getUser, ref, 2, "three");
      assert.equal(deleteComment(db, third.id, { id: 99, username: "root", role: "admin" }), true);
    });
  });
});

describe("pages quick path", () => {
  let dir: string;

  beforeEach(() => {
    db = new Database(":memory:") as unknown as ExtDb;
    initDb(db);
    users.clear();
    registerUser(1, "mimsy");
    dir = mkdtempSync(resolve(tmpdir(), "pages-quick-"));
    mkdirSync(resolve(dir, "home", "pages"), { recursive: true });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("slugs a title into a filename", () => {
    assert.equal(slugify("The Skeleton's Calendar"), "the-skeletons-calendar");
    assert.equal(slugify("  Mixed --- Punctuation!  "), "mixed-punctuation");
  });

  it("lands in notes/ and suffixes rather than overwriting", () => {
    const pagesDir = resolve(dir, "home", "pages");
    assert.equal(allocateQuickPath(pagesDir, "The tideline"), "notes/the-tideline.md");

    mkdirSync(resolve(pagesDir, "notes"), { recursive: true });
    writeFileSync(resolve(pagesDir, "notes", "the-tideline.md"), "x");
    assert.equal(allocateQuickPath(pagesDir, "The tideline"), "notes/the-tideline-2.md");
  });

  it("falls back to a usable slug for a title with nothing sluggable in it", () => {
    assert.equal(allocateQuickPath(resolve(dir, "home", "pages"), "———"), "notes/untitled.md");
  });

  it("never reuses a tombstoned address, so a dead thread can't graft onto new writing", () => {
    const ctx = fakeCtx(dir);
    // A page existed at notes/the-tideline.md, was commented on, then deleted —
    // the row survives as a tombstone holding the conversation.
    syncPublishedPages(db, "mimsy", [{ file: "notes/the-tideline.md", hash: "h1" }]);
    db.prepare(
      "INSERT INTO page_comments (mind, file, author_id, content) VALUES (?, ?, ?, ?)",
    ).run("mimsy", "notes/the-tideline.md", 1, "a letter");
    syncPublishedPages(db, "mimsy", []);
    rmSync(resolve(dir, "home", "pages", "notes"), { recursive: true, force: true });

    // Writing something new with the same title must not land on that address.
    const result = writeQuickPage(ctx, "mimsy", dir, "The tideline", "Something unrelated.");
    assert.equal(result.file, "notes/the-tideline-2.md");
    assert.ok(getPage(db, "mimsy", "notes/the-tideline.md")?.deleted_at, "tombstone undisturbed");
  });

  it("announces the page once, not twice", () => {
    const events: string[] = [];
    const ctx = fakeCtx(dir);
    ctx.publishActivity = (e) => events.push(e.summary);
    writeQuickPage(ctx, "mimsy", dir, "The tideline", "body");
    // The caller emits the rich event; the publish inside must stay quiet about
    // the file it was handed, or one `pages write` posts to the feed twice.
    assert.deepEqual(events, []);
  });

  it("writes and publishes in a single step", () => {
    const ctx = fakeCtx(dir);
    const result = writeQuickPage(ctx, "mimsy", dir, "The tideline", "Something I noticed.");

    assert.equal(result.file, "notes/the-tideline.md");
    // Published, not drafted — the whole point of the quick path.
    const page = getPage(db, "mimsy", "notes/the-tideline.md");
    assert.ok(page, "the page is published, with no separate publish step");
    assert.equal(page.deleted_at, null);
    assert.ok(page.hash, "and has a content hash comments can be keyed against");
    assert.deepEqual(result.publish.diff.added, ["notes/the-tideline.md"]);
  });

  it("writes frontmatter with the title so the page renders with one", () => {
    const ctx = fakeCtx(dir);
    writeQuickPage(ctx, "mimsy", dir, 'A "quoted" title', "body");
    const written = readFileSync(
      resolve(dir, "home", "pages", "notes", "a-quoted-title.md"),
      "utf-8",
    );
    assert.match(written, /^---\ntitle: "A \\"quoted\\" title"\n---\n/);
    assert.match(written, /body\n$/);
  });
});

// --- helpers -------------------------------------------------------------

/** Minimal ExtensionContext for exercising publish paths. */
function fakeCtx(mindDir: string): ExtensionContext {
  const dataDir = mkdtempSync(resolve(tmpdir(), "pages-data-"));
  return {
    db,
    dataDir,
    authMiddleware: (async (_c: unknown, next: () => Promise<void>) => next()) as never,
    requireSelf: () => (async (_c: unknown, next: () => Promise<void>) => next()) as never,
    resolveUser: () => null,
    getUser,
    getUserByUsername: async (username: string) =>
      [...users.values()].find((u) => u.username === username) ?? null,
    publishActivity: () => {},
    getMindDir: async () => mindDir,
    getSystemsConfig: () => null,
    announceToSystem: async () => {},
    recordNotice: async () => {},
    isIsolationEnabled: () => false,
    getMindUser: (name: string) => `mind-${name}`,
    getSpiritName: () => "volute",
  };
}
