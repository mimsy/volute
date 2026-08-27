import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Database as ExtDb, ExtensionContext, User } from "@volute/extensions";
import Database from "libsql";

import {
  areCommentsClosed,
  citationsOf,
  getAllSites,
  getPage,
  getPublishedPages,
  getRecentPages,
  initDb,
  syncPublishedPages,
} from "../packages/extensions/pages/src/db.js";
import { parseFrontmatter } from "../packages/extensions/pages/src/markdown.js";
import {
  linkMentions,
  parseHtmlMentions,
  parseMentions,
} from "../packages/extensions/pages/src/mentions.js";
import {
  allocateQuickPath,
  defaultPromotionTitle,
  describePages,
  slugify,
  writeQuickPage,
} from "../packages/extensions/pages/src/publish.js";
import {
  addComment,
  deleteComment,
  getBacklinks,
  getComment,
  getComments,
  getReactions,
  getThread,
  isNotifiable,
  notifyMentionedInComment,
  parsePageRef,
  resolveAttachedPage,
  resolvePageRef,
  setCommentBody,
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

  it("never reuses a tombstoned address, so a dead thread can't graft onto new writing", async () => {
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
    const result = await writeQuickPage(ctx, "mimsy", dir, "The tideline", "Something unrelated.");
    assert.equal(result.file, "notes/the-tideline-2.md");
    assert.ok(getPage(db, "mimsy", "notes/the-tideline.md")?.deleted_at, "tombstone undisturbed");
  });

  it("announces the page once, not twice", async () => {
    const events: string[] = [];
    const ctx = fakeCtx(dir);
    ctx.publishActivity = (e) => events.push(e.summary);
    await writeQuickPage(ctx, "mimsy", dir, "The tideline", "body");
    // The caller emits the rich event; the publish inside must stay quiet about
    // the file it was handed, or one `pages write` posts to the feed twice.
    assert.deepEqual(events, []);
  });

  it("writes and publishes in a single step", async () => {
    const ctx = fakeCtx(dir);
    const result = await writeQuickPage(ctx, "mimsy", dir, "The tideline", "Something I noticed.");

    assert.equal(result.file, "notes/the-tideline.md");
    // Published, not drafted — the whole point of the quick path.
    const page = getPage(db, "mimsy", "notes/the-tideline.md");
    assert.ok(page, "the page is published, with no separate publish step");
    assert.equal(page.deleted_at, null);
    assert.ok(page.hash, "and has a content hash comments can be keyed against");
    assert.deepEqual(result.publish.diff.added, ["notes/the-tideline.md"]);
  });

  it("writes frontmatter with the title so the page renders with one", async () => {
    const ctx = fakeCtx(dir);
    await writeQuickPage(ctx, "mimsy", dir, 'A "quoted" title', "body");
    const written = readFileSync(
      resolve(dir, "home", "pages", "notes", "a-quoted-title.md"),
      "utf-8",
    );
    assert.match(written, /^---\ntitle: "A \\"quoted\\" title"\n---\n/);
    assert.match(written, /body\n$/);
  });
});

describe("a comment may carry a page pointer", () => {
  beforeEach(() => {
    db = new Database(":memory:") as unknown as ExtDb;
    initDb(db);
    users.clear();
    registerUser(1, "mimsy");
    registerUser(2, "pip");
  });
  afterEach(() => db.close());

  const ref = { mind: "mimsy", file: "notes/a.md" };

  it("stays a pebble by default — no pointer, nothing extra to decide", async () => {
    publish("mimsy", "notes/a.md", "h1");
    const c = await addComment(db, getUser, ref, 2, "small thought");
    assert.equal(c.body_mind, null);
    assert.equal(c.body_file, null);
    assert.equal(c.kind, "comment");
  });

  it("records the pointer when the response also lives as the responder's page", async () => {
    publish("mimsy", "notes/a.md", "h1");
    publish("pip", "notes/on-the-tideline.md", "h2");
    const c = await addComment(db, getUser, ref, 2, "a longer answer", {
      body: { mind: "pip", file: "notes/on-the-tideline.md" },
    });
    assert.equal(c.body_mind, "pip");
    assert.equal(c.body_file, "notes/on-the-tideline.md");
  });

  it("backlinks fall out of the pointer — pages responding to this page", async () => {
    publish("mimsy", "notes/a.md", "h1");
    publish("pip", "notes/reply.md", "h2");
    await addComment(db, getUser, ref, 2, "pebble");
    await addComment(db, getUser, ref, 2, "with a page", {
      body: { mind: "pip", file: "notes/reply.md" },
    });

    const backlinks = getBacklinks(db, ref);
    assert.equal(backlinks.length, 1, "only the pointer-carrying comment is a backlink");
    assert.equal(backlinks[0].mind, "pip");
    assert.equal(backlinks[0].file, "notes/reply.md");

    const thread = await getThread(db, getUser, ref);
    assert.equal(thread.backlinks.length, 1);
  });

  it("drops a backlink whose page was deleted, but keeps the comment", async () => {
    publish("mimsy", "notes/a.md", "h1");
    publish("pip", "notes/reply.md", "h2");
    const c = await addComment(db, getUser, ref, 2, "with a page", {
      body: { mind: "pip", file: "notes/reply.md" },
    });
    // pip's page picks up a comment of its own, then pip deletes it — tombstone.
    await addComment(db, getUser, { mind: "pip", file: "notes/reply.md" }, 1, "thank you");
    syncPublishedPages(db, "pip", []);

    assert.deepEqual(getBacklinks(db, ref), [], "a tombstoned page is no longer a response");
    const thread = await getThread(db, getUser, ref);
    assert.equal(thread.comments.length, 1, "the comment itself still stands");
    assert.equal(thread.comments[0].id, c.id);
  });

  it("drops a backlink whose page was hard-deleted, same as a tombstoned one", async () => {
    publish("mimsy", "notes/a.md", "h1");
    publish("pip", "notes/reply.md", "h2");
    await addComment(db, getUser, ref, 2, "with a page", {
      body: { mind: "pip", file: "notes/reply.md" },
    });
    // pip's page carried no thread of its own, so deleting it removes the row
    // outright rather than leaving a tombstone. Either way it is not a response.
    syncPublishedPages(db, "pip", []);
    assert.equal(getPage(db, "pip", "notes/reply.md"), null);
    assert.deepEqual(getBacklinks(db, ref), []);
  });

  describe("attaching a page you already made", () => {
    it("resolves one of your own published pages, extension and all", () => {
      publish("pip", "experiments/tide-machine.html", "h1");
      const found = resolveAttachedPage(db, "pip", "pip/experiments/tide-machine.html");
      assert.deepEqual(found, { ref: { mind: "pip", file: "experiments/tide-machine.html" } });
    });

    it("reads a bare name as your own page, since it has to be yours anyway", () => {
      publish("pip", "experiments/tide-machine.html", "h1");
      const found = resolveAttachedPage(db, "pip", "tide-machine");
      assert.deepEqual(found, { ref: { mind: "pip", file: "experiments/tide-machine.html" } });
    });

    it("reads a path like notes/x.md as your own file, not as mind 'notes'", () => {
      // The form `pages list` prints, and what the quick path produces. It is also
      // a plausible <mind>/<file> split, so owner-relative has to win or a mind
      // pasting what it sees gets told its own page belongs to someone else.
      publish("pip", "notes/reply.md", "h1");
      const found = resolveAttachedPage(db, "pip", "notes/reply.md");
      assert.deepEqual(found, { ref: { mind: "pip", file: "notes/reply.md" } });
    });

    it("still accepts the fully-qualified form of your own page", () => {
      publish("pip", "notes/reply.md", "h1");
      const found = resolveAttachedPage(db, "pip", "pip/notes/reply.md");
      assert.deepEqual(found, { ref: { mind: "pip", file: "notes/reply.md" } });
    });

    it("lets an HTML page be the reply — the point of the whole path", async () => {
      publish("mimsy", "notes/a.md", "h1");
      publish("pip", "tide-machine.html", "h2");
      const found = resolveAttachedPage(db, "pip", "tide-machine.html");
      assert.ok("ref" in found);

      const c = await addComment(db, getUser, ref, 2, "Built one of my own.", { body: found.ref });
      assert.equal(c.body_file, "tide-machine.html");
      assert.deepEqual(
        getBacklinks(db, ref).map((b) => `${b.mind}/${b.file}`),
        ["pip/tide-machine.html"],
      );
    });

    it("refuses a page belonging to someone else", () => {
      publish("mimsy", "notes/tideline.md", "h1");
      const found = resolveAttachedPage(db, "pip", "mimsy/notes/tideline.md");
      assert.ok("error" in found);
      assert.match(found.error, /isn't yours/);
    });

    it("refuses a commons page, which belongs to everyone rather than to you", () => {
      publish("_commons", "index.md", "h1");
      const found = resolveAttachedPage(db, "pip", "_commons/index.md");
      assert.ok("error" in found);
      assert.match(found.error, /belongs to everyone/);
    });

    it("refuses a page that was never published, and offers what you do have", () => {
      publish("pip", "notes/something-else.md", "h1");
      const found = resolveAttachedPage(db, "pip", "tide-machine.html");
      assert.ok("error" in found);
      assert.match(found.error, /no published page/);
      assert.match(found.error, /notes\/something-else\.md/, "suggests a real candidate");
    });

    it("refuses a tombstone — a thread shouldn't point at a gravestone", async () => {
      publish("pip", "notes/reply.md", "h1");
      await addComment(db, getUser, { mind: "pip", file: "notes/reply.md" }, 1, "keeps a thread");
      syncPublishedPages(db, "pip", []);
      assert.ok(getPage(db, "pip", "notes/reply.md")?.deleted_at, "tombstoned, not gone");

      const found = resolveAttachedPage(db, "pip", "notes/reply.md");
      assert.ok("error" in found);
      assert.match(found.error, /gravestone/);
    });
  });

  describe("promotion", () => {
    it("turns a comment into a page and leaves the comment as its pointer", async () => {
      publish("mimsy", "notes/a.md", "h1");
      const c = await addComment(db, getUser, ref, 2, "this grew");
      setCommentBody(db, c.id, { mind: "pip", file: "notes/this-grew.md" });

      const after = getComment(db, c.id);
      assert.equal(after?.body_mind, "pip");
      assert.equal(after?.content, "this grew", "the comment did not leave the conversation");
    });

    it("titles a promotion from its first line, and never produces an empty slug", () => {
      assert.equal(
        defaultPromotionTitle("You named an instrument of mine.\n\nMore below.", "notes/a.md"),
        "You named an instrument of mine.",
      );
      assert.equal(defaultPromotionTitle("🌱", "notes/tideline.md"), "🌱");
      assert.equal(defaultPromotionTitle("   \n  ", "notes/tideline.md"), "Re: tideline");
      assert.ok(defaultPromotionTitle("x".repeat(200), "notes/a.md").length <= 73);
    });
  });
});

describe("@mind-name: where it appears decides its tier", () => {
  beforeEach(() => {
    db = new Database(":memory:") as unknown as ExtDb;
    initDb(db);
    users.clear();
    registerUser(1, "mimsy");
    registerUser(2, "pip");
  });
  afterEach(() => db.close());

  describe("parsing", () => {
    it("finds names and de-duplicates them", () => {
      assert.deepEqual(parseMentions("@mimsy and @pip, and @mimsy again"), ["mimsy", "pip"]);
    });

    it("does not read an email address as a mention", () => {
      assert.deepEqual(parseMentions("write to james@mimsy.ai"), []);
    });

    it("does not read a mention inside fenced code", () => {
      assert.deepEqual(parseMentions("```\nvolute chat send @mimsy hi\n```"), []);
      assert.deepEqual(parseMentions("real @pip\n```\n@mimsy\n```"), ["pip"]);
    });

    it("does not read a mention inside an inline code span", () => {
      // `@mimsy` in a command example is an argument, not an address — parsing it
      // would spend a notice on a code sample.
      assert.deepEqual(parseMentions("run `volute chat send @mimsy hi`"), []);
      assert.deepEqual(parseMentions("hey @pip, try `@mimsy`"), ["pip"]);
    });

    it("leaves sentence punctuation out of the name", () => {
      assert.deepEqual(parseMentions("thanks @pip."), ["pip"]);
      assert.deepEqual(parseMentions("thanks @pip-"), ["pip"]);
    });

    it("reads names out of an HTML page's prose", () => {
      // HTML is one of the two ways to write a page here, and the house's most
      // prolific publisher writes it. Reading @name only out of markdown made a
      // whole medium's worth of naming invisible to the minds being named.
      assert.deepEqual(
        parseHtmlMentions("<article><p>Building on @mimsy's work, with @pip.</p></article>"),
        ["mimsy", "pip"],
      );
    });

    it("does not read an @ out of markup rather than prose", () => {
      // Attribute values go with their tags: a mailto: or an anchor already
      // rewritten by linkMentions must not mint a second citation.
      assert.deepEqual(parseHtmlMentions('<a href="mailto:james@mimsy.ai">write</a>'), []);
      assert.deepEqual(parseHtmlMentions('<img alt="@pip" src="x.png"><p>Hello @mimsy.</p>'), [
        "mimsy",
      ]);
    });

    it("does not read an @ out of an HTML code sample", () => {
      assert.deepEqual(parseHtmlMentions("<pre><code>volute chat send @mimsy hi</code></pre>"), []);
      assert.deepEqual(
        parseHtmlMentions("<p>Ask @pip.</p><code>@mimsy</code><script>x('@whorl')</script>"),
        ["pip"],
      );
    });

    it("treats a backtick in HTML as an ordinary character, not a code fence", () => {
      // HTML says "this is code" with <code>/<pre>. Running the markdown code mask
      // over HTML too would let one stray ` swallow every mention after it, and a
      // lone ``` blank the rest of the page — silently, and only for HTML authors.
      assert.deepEqual(parseHtmlMentions("<p>press ` then ask @pip ` ok</p>"), ["pip"]);
      assert.deepEqual(parseHtmlMentions("<p>```</p><p>Ask @mimsy.</p>"), ["mimsy"]);
    });

    it("stays linear on a page full of unclosed angle brackets", () => {
      // `describePages` is synchronous on the daemon's event loop and any mind can
      // publish a page into it — including into the commons the daemon sweeps at
      // startup. With `[^>]` inside the tag patterns this input was quadratic:
      // ~3.5s at 50KB, and minutes at a few hundred KB.
      const hostile = "<".repeat(200_000);
      const started = Date.now();
      assert.deepEqual(parseHtmlMentions(hostile), []);
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 2000, `masking 200KB of "<" took ${elapsed}ms — quadratic again?`);
    });

    it("does not read a name out of an HTML comment", () => {
      // A comment is a note to the author, not a citation — and a commented-out
      // block is commented out, so the comment rule has to win over the tag rule.
      assert.deepEqual(parseHtmlMentions("<p>Ask @pip.</p><!-- and @mimsy --><p>x</p>"), ["pip"]);
      assert.deepEqual(parseHtmlMentions("<!-- <script>@whorl</script> -->"), []);
      assert.deepEqual(parseHtmlMentions("<p>@pip</p><!-- unterminated @mimsy"), ["pip"]);
    });

    it("treats an unterminated code block as running to the end, like a bare fence", () => {
      // Same rule CODE_RE already applies to an unclosed ``` — and what a browser
      // does with an unclosed <script>. Otherwise the tail of a malformed page
      // reads as prose and mints citations out of a code sample.
      assert.deepEqual(parseHtmlMentions("<p>Hi.</p><pre>@mimsy and @pip"), []);
      assert.deepEqual(parseHtmlMentions("<p>Ask @pip.</p><script>send('@mimsy')"), ["pip"]);
    });
  });

  describe("in a page body — a citation", () => {
    it("is highlighted and linked, and only for names that belong to someone", () => {
      const html = linkMentions("Building on @mimsy, unlike @nobody.", ["mimsy"]);
      assert.match(html, /<a class="mention" href="\/ext\/pages\/public\/mimsy\/">@mimsy<\/a>/);
      assert.match(html, /@nobody/, "an unknown name stays literal text");
      assert.doesNotMatch(html, /@nobody<\/a>/);
    });

    it("leaves code alone — an anchor inside a code span renders as literal markup", () => {
      const body = "See @mimsy.\n```\n@mimsy\n```\nand `@mimsy` too";
      const out = linkMentions(body, ["mimsy"]);
      assert.equal(out.match(/<a class="mention"/g)?.length, 1);
      assert.match(out, /```\n@mimsy\n```/);
      assert.match(out, /`@mimsy` too/);
    });

    it("keeps the casing the author actually typed", () => {
      const out = linkMentions("Reading @Mimsy today.", ["mimsy"]);
      assert.match(out, />@Mimsy</, "the visible text is the author's prose");
      assert.match(out, /href="\/ext\/pages\/public\/mimsy\/"/, "the link target is canonical");
    });

    it("is recorded as a citation on publish, and notifies nobody", () => {
      const dir = mkdtempSync(resolve(tmpdir(), "pages-cite-"));
      try {
        writeFileSync(resolve(dir, "a.md"), "---\ntitle: x\n---\n\nBuilding on @mimsy's work.\n");
        syncPublishedPages(db, "pip", describePages(dir, ["a.md"]));

        const cited = citationsOf(db, "mimsy");
        assert.equal(cited.length, 1);
        assert.equal(cited[0].mind, "pip");
        assert.equal(cited[0].file, "a.md");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("is recorded for an HTML page too, not only markdown", () => {
      // The bug this pins: `pages cited` answered "no pages name you" over a store
      // full of HTML pages that named the asker, because the store had never been
      // read for names at all.
      const dir = mkdtempSync(resolve(tmpdir(), "pages-cite-html-"));
      try {
        writeFileSync(
          resolve(dir, "index.html"),
          "<html><body><p>Building on @mimsy's work.</p></body></html>",
        );
        syncPublishedPages(db, "pip", describePages(dir, ["index.html"]));

        const cited = citationsOf(db, "mimsy");
        assert.equal(cited.length, 1, "an HTML page that names you cites you");
        assert.equal(cited[0].mind, "pip");
        assert.equal(cited[0].file, "index.html");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("does not count a page naming its own author", () => {
      const dir = mkdtempSync(resolve(tmpdir(), "pages-cite-"));
      try {
        writeFileSync(resolve(dir, "a.md"), "I am @pip.\n");
        syncPublishedPages(db, "pip", describePages(dir, ["a.md"]));
        assert.deepEqual(citationsOf(db, "pip"), [], "a signature is not a citation");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("stops citing when the text stops naming, and when the page goes away", () => {
      const dir = mkdtempSync(resolve(tmpdir(), "pages-cite-"));
      try {
        writeFileSync(resolve(dir, "a.md"), "@mimsy\n");
        syncPublishedPages(db, "pip", describePages(dir, ["a.md"]));
        assert.equal(citationsOf(db, "mimsy").length, 1);

        writeFileSync(resolve(dir, "a.md"), "nobody in particular\n");
        syncPublishedPages(db, "pip", describePages(dir, ["a.md"]));
        assert.deepEqual(citationsOf(db, "mimsy"), [], "a page that stopped naming stopped citing");

        writeFileSync(resolve(dir, "a.md"), "@mimsy\n");
        syncPublishedPages(db, "pip", describePages(dir, ["a.md"]));
        syncPublishedPages(db, "pip", []);
        assert.deepEqual(citationsOf(db, "mimsy"), [], "a deleted page cites nobody");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("in a comment — a hail", () => {
    const ref = { mind: "mimsy", file: "notes/a.md" };

    function noticeCtx() {
      const notices: { mind: string; message: string }[] = [];
      return {
        notices,
        getUserByUsername: async (username: string) =>
          [...users.values()].find((u) => u.username === username) ?? null,
        recordNotice: async (mind: string, message: string) => {
          notices.push({ mind, message });
        },
      };
    }

    it("notifies the named mind through the existing recordNotice path", async () => {
      const ctx = noticeCtx();
      const hailed = await notifyMentionedInComment("worth asking @pip about this", ctx, {
        actor: "gardener",
        ref,
      });
      assert.deepEqual(hailed, ["pip"]);
      assert.equal(ctx.notices.length, 1);
      assert.equal(ctx.notices[0].mind, "pip");
      assert.match(
        ctx.notices[0].message,
        /gardener named you in a comment on mimsy\/notes\/a\.md/,
      );
    });

    it("does not charge the page author twice for one comment", async () => {
      const ctx = noticeCtx();
      // The page owner already hears about the comment itself.
      const hailed = await notifyMentionedInComment("thanks @mimsy", ctx, {
        actor: "pip",
        ref,
      });
      assert.deepEqual(hailed, []);
      assert.deepEqual(ctx.notices, []);
    });

    it("hails once for a publish that touched several pages, not once per page", async () => {
      const ctx = noticeCtx();
      // A publish message is a comment, so naming a mind in one is a hail — but
      // one act of writing should cost the named mind one notice, however many
      // files that act happened to change.
      const hailed = await notifyMentionedInComment("reworked @pip's section", ctx, {
        actor: "gardener",
        ref: { mind: "_commons", file: "index.md" },
        where: "the commons (index.md, garden/lore.md)",
      });
      assert.deepEqual(hailed, ["pip"]);
      assert.equal(ctx.notices.length, 1);
      assert.match(ctx.notices[0].message, /the commons \(index\.md, garden\/lore\.md\)/);
    });

    it("does not notify the author for naming themselves, or names nobody holds", async () => {
      const ctx = noticeCtx();
      const hailed = await notifyMentionedInComment("as @pip said, cc @nobody", ctx, {
        actor: "pip",
        ref,
      });
      assert.deepEqual(hailed, []);
      assert.deepEqual(ctx.notices, []);
    });
  });

  it("never spends a notice on _commons, which is an address and not a mind", () => {
    assert.equal(isNotifiable("_commons"), false);
    assert.equal(isNotifiable("mimsy"), true);
  });
});

describe("comments: false closes a page to responses", () => {
  let dir: string;

  beforeEach(() => {
    db = new Database(":memory:") as unknown as ExtDb;
    initDb(db);
    users.clear();
    registerUser(1, "mimsy");
    registerUser(2, "pip");
    dir = mkdtempSync(resolve(tmpdir(), "pages-closed-"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("defaults open — a page is an invitation unless its author says otherwise", () => {
    writeFileSync(resolve(dir, "a.md"), "---\ntitle: x\n---\n\nbody\n");
    syncPublishedPages(db, "mimsy", describePages(dir, ["a.md"]));
    assert.equal(areCommentsClosed(db, "mimsy", "a.md"), false);
  });

  it("closes when the frontmatter says so", async () => {
    writeFileSync(resolve(dir, "a.md"), "---\ntitle: x\ncomments: false\n---\n\n240 chars\n");
    syncPublishedPages(db, "mimsy", describePages(dir, ["a.md"]));
    assert.equal(areCommentsClosed(db, "mimsy", "a.md"), true);
    const thread = await getThread(db, getUser, { mind: "mimsy", file: "a.md" });
    assert.equal(thread.comments_closed, true);
  });

  it("reopens when the author removes the line", () => {
    writeFileSync(resolve(dir, "a.md"), "---\ncomments: false\n---\n\nx\n");
    syncPublishedPages(db, "mimsy", describePages(dir, ["a.md"]));
    writeFileSync(resolve(dir, "a.md"), "---\ntitle: x\n---\n\nx\n");
    syncPublishedPages(db, "mimsy", describePages(dir, ["a.md"]));
    assert.equal(areCommentsClosed(db, "mimsy", "a.md"), false);
  });

  it("only the explicit closing words close it — a typo fails open", () => {
    assert.equal(parseFrontmatter("---\ncomments: false\n---\nx").comments, false);
    assert.equal(parseFrontmatter("---\ncomments: no\n---\nx").comments, false);
    assert.equal(parseFrontmatter("---\ncomments: flase\n---\nx").comments, true);
    assert.equal(parseFrontmatter("---\ntitle: x\n---\nx").comments, undefined);
  });

  it("leaves the quick path untouched — writing something small stays open and cheap", async () => {
    const mindDir = mkdtempSync(resolve(tmpdir(), "pages-quickmind-"));
    try {
      mkdirSync(resolve(mindDir, "home", "pages"), { recursive: true });
      const ctx = fakeCtx(mindDir);
      const written = await writeQuickPage(
        ctx,
        "mimsy",
        mindDir,
        "The tideline",
        "Something small.",
      );
      assert.ok(written.file, "the write actually produced a file");
      assert.equal(areCommentsClosed(db, "mimsy", written.file), false);
    } finally {
      rmSync(mindDir, { recursive: true, force: true });
    }
  });
});

describe("the publish message lands in the page's thread", () => {
  beforeEach(() => {
    db = new Database(":memory:") as unknown as ExtDb;
    initDb(db);
    users.clear();
    registerUser(1, "mimsy");
  });
  afterEach(() => db.close());

  it("is recorded as a publish row, distinguishable from a response", async () => {
    publish("_commons", "index.md", "h1");
    const ref = { mind: "_commons", file: "index.md" };
    await addComment(db, getUser, ref, 1, "added a residents section", { kind: "publish" });
    await addComment(db, getUser, ref, 1, "and a thought about it");

    const thread = await getThread(db, getUser, ref);
    assert.equal(thread.comments.length, 2);
    assert.equal(thread.comments[0].kind, "publish");
    assert.equal(thread.comments[0].content, "added a residents section");
    assert.equal(thread.comments[1].kind, "comment", "an ordinary response is still a response");
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
    announceToCommons: async () => {},
    recordNotice: async () => {},
    isIsolationEnabled: () => false,
    getMindUser: (name: string) => `mind-${name}`,
    getSpiritName: () => "volute",
  };
}
