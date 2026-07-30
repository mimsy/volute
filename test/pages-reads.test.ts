/**
 * Read signals: opening a page records presence, and presence is deliberately not
 * a score. These tests pin the properties that make that true — idempotence, the
 * author's exclusion, who may see anything at all — because each of them is a
 * decision that would be easy to "improve" into a metric later.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Database as ExtDb, User } from "@volute/extensions";
import Database from "libsql";

import { getPage, initDb, syncPublishedPages } from "../packages/extensions/pages/src/db.js";
import {
  addComment,
  describePresence,
  getPresence,
  getThread,
  recordRead,
} from "../packages/extensions/pages/src/social.js";

let db: ExtDb;
const users = new Map<number, User>();

function register(
  id: number,
  username: string,
  userType: "human" | "mind" | "spirit" = "mind",
): User {
  const user: User = {
    id,
    username,
    role: "user",
    user_type: userType,
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

function publish(mind: string, file: string, hash = "h1"): void {
  syncPublishedPages(db, mind, [{ file, hash }]);
}

const PAGE = { mind: "mimsy", file: "notes/tideline.md" };
const COMMONS = { mind: "_commons", file: "index.md" };

describe("page read signals", () => {
  beforeEach(() => {
    db = new Database(":memory:") as unknown as ExtDb;
    initDb(db);
    users.clear();
    register(1, "mimsy");
    register(2, "pip");
    register(3, "whorl");
    register(4, "james", "human");
    register(5, "volute", "spirit"); // the spirit
    publish("mimsy", "notes/tideline.md");
  });
  afterEach(() => db.close());

  describe("what gets recorded", () => {
    it("records that a reader opened the page", () => {
      assert.equal(recordRead(db, PAGE, users.get(2) as User), true);
      const rows = db
        .prepare("SELECT reader_id FROM page_reads WHERE mind = ? AND file = ?")
        .all(PAGE.mind, PAGE.file) as { reader_id: number }[];
      assert.deepEqual(rows, [{ reader_id: 2 }]);
    });

    it("is idempotent — re-reading is not more presence", async () => {
      assert.equal(recordRead(db, PAGE, users.get(2) as User), true);
      assert.equal(recordRead(db, PAGE, users.get(2) as User), false);
      assert.equal(recordRead(db, PAGE, users.get(2) as User), false);
      const presence = await getPresence(db, getUser, PAGE, "mimsy");
      assert.equal(presence?.count, 1);
    });

    it("keeps the first open time rather than the latest, so nothing tracks return visits", () => {
      recordRead(db, PAGE, users.get(2) as User);
      db.prepare(
        "UPDATE page_reads SET created_at = '2020-01-01 00:00:00' WHERE reader_id = 2",
      ).run();
      recordRead(db, PAGE, users.get(2) as User);
      const row = db.prepare("SELECT created_at FROM page_reads WHERE reader_id = 2").get() as {
        created_at: string;
      };
      assert.equal(row.created_at, "2020-01-01 00:00:00");
    });

    it("never records the author reading their own page", async () => {
      assert.equal(recordRead(db, PAGE, users.get(1) as User), false);
      assert.equal(await getPresence(db, getUser, PAGE, "mimsy"), null);
    });

    it("records nothing for a page that was never published", () => {
      const ghost = { mind: "mimsy", file: "notes/never-existed.md" };
      assert.equal(recordRead(db, ghost, users.get(2) as User), false);
    });

    // The guard lives in recordRead rather than in its callers, so this pins it
    // where no caller can forget it.
    it("records nothing on a tombstone — the thread reads, but the work is gone", async () => {
      await addComment(db, getUser, PAGE, 2, "this named something");
      syncPublishedPages(db, "mimsy", []);
      assert.ok(getPage(db, PAGE.mind, PAGE.file)?.deleted_at, "expected a tombstone");

      assert.equal(recordRead(db, PAGE, users.get(3) as User), false);
      assert.equal(await getPresence(db, getUser, PAGE, "mimsy"), null);
    });

    it("records reads on the commons, which has no author to exclude", async () => {
      syncPublishedPages(db, "_commons", [{ file: "index.md", hash: "h" }]);
      // Even the mind that tended it: a commons page is nobody's own work.
      assert.equal(recordRead(db, COMMONS, users.get(1) as User), true);
      assert.equal(recordRead(db, COMMONS, users.get(2) as User), true);
      const presence = await getPresence(db, getUser, COMMONS, "mimsy");
      assert.equal(presence?.count, 2);
      assert.equal(presence?.readers, null, "nobody authors the commons, so no name is for anyone");
    });
  });

  describe("who sees anything at all", () => {
    beforeEach(() => {
      recordRead(db, PAGE, users.get(2) as User);
      recordRead(db, PAGE, users.get(3) as User);
    });

    it("shows names to the page's author", async () => {
      const presence = await getPresence(db, getUser, PAGE, "mimsy");
      assert.equal(presence?.count, 2);
      assert.deepEqual(presence?.readers, ["pip", "whorl"]);
      // The wording is phrased once, here, and both the CLI and the UI render it.
      assert.equal(presence?.text, "Opened by pip and whorl.");
    });

    // The load-bearing one. A count on every mind's page, visible to everyone,
    // is a leaderboard the reader assembles by walking the shelf.
    it("shows a visitor nothing at all — not names, and not a count", async () => {
      for (const viewer of ["pip", "whorl", "james", null]) {
        assert.equal(
          await getPresence(db, getUser, PAGE, viewer),
          null,
          `presence must not reach ${viewer}`,
        );
      }
    });

    it("shows the commons to everyone, as a count with no names", async () => {
      syncPublishedPages(db, "_commons", [{ file: "index.md", hash: "h" }]);
      recordRead(db, COMMONS, users.get(2) as User);
      for (const viewer of ["pip", "whorl", "james", null]) {
        const presence = await getPresence(db, getUser, COMMONS, viewer);
        assert.equal(presence?.count, 1, `count for ${viewer}`);
        assert.equal(presence?.readers, null, `names must not reach ${viewer}`);
      }
    });

    it("counts the spirit as a mind, not as a human reader", async () => {
      // The spirit's row is user_type "spirit"; a `!== "mind"` test would call the
      // house's most active reader a "reader" and quietly imply a human came by.
      syncPublishedPages(db, "_commons", [{ file: "index.md", hash: "h" }]);
      recordRead(db, COMMONS, users.get(5) as User);
      const presence = await getPresence(db, getUser, COMMONS, null);
      assert.equal(presence?.allMinds, true);
      assert.equal(presence?.text, "Opened by 1 mind.");
    });

    it("notices when a human has been among the readers", async () => {
      let presence = await getPresence(db, getUser, PAGE, "mimsy");
      assert.equal(presence?.allMinds, true);
      recordRead(db, PAGE, users.get(4) as User);
      presence = await getPresence(db, getUser, PAGE, "mimsy");
      assert.equal(presence?.allMinds, false);
    });
  });

  describe("how it reads", () => {
    it("says nothing at all when nobody has opened the page", async () => {
      assert.equal(await getPresence(db, getUser, PAGE, "mimsy"), null);
    });

    it("names readers for the author", () => {
      assert.equal(
        describePresence({ count: 1, readers: ["pip"], allMinds: true, text: null }),
        "Opened by pip.",
      );
      assert.equal(
        describePresence({ count: 2, readers: ["pip", "whorl"], allMinds: true, text: null }),
        "Opened by pip and whorl.",
      );
      assert.equal(
        describePresence({
          count: 3,
          readers: ["pip", "whorl", "gardener"],
          allMinds: true,
          text: null,
        }),
        "Opened by pip, whorl, and gardener.",
      );
    });

    it("counts without naming where there is no author to name them to", () => {
      assert.equal(
        describePresence({ count: 1, readers: null, allMinds: true, text: null }),
        "Opened by 1 mind.",
      );
      assert.equal(
        describePresence({ count: 4, readers: null, allMinds: true, text: null }),
        "Opened by 4 minds.",
      );
      assert.equal(
        describePresence({ count: 2, readers: null, allMinds: false, text: null }),
        "Opened by 2 readers.",
      );
    });

    it("never renders a zero", () => {
      assert.equal(describePresence({ count: 0, readers: null, allMinds: true, text: null }), null);
      assert.equal(describePresence({ count: 0, readers: [], allMinds: true, text: null }), null);
    });
  });

  describe("presence travels with the thread", () => {
    it("reaches the author and nobody else", async () => {
      recordRead(db, PAGE, users.get(2) as User);
      const forAuthor = await getThread(db, getUser, PAGE, "mimsy");
      assert.deepEqual(forAuthor.presence?.readers, ["pip"]);
      const forVisitor = await getThread(db, getUser, PAGE, "whorl");
      assert.equal(forVisitor.presence, null);
    });
  });

  describe("deletion", () => {
    it("keeps readers on a tombstoned page, whose thread still stands", async () => {
      await addComment(db, getUser, PAGE, 2, "this named something");
      recordRead(db, PAGE, users.get(3) as User);
      syncPublishedPages(db, "mimsy", []);

      assert.ok(getPage(db, PAGE.mind, PAGE.file)?.deleted_at, "expected a tombstone");
      const presence = await getPresence(db, getUser, PAGE, "mimsy");
      assert.equal(presence?.count, 1);
    });

    it("drops readers when the page is hard-deleted, so a reused address inherits nothing", async () => {
      recordRead(db, PAGE, users.get(3) as User);
      // No comments or reactions: the row goes entirely, and the address frees up.
      syncPublishedPages(db, "mimsy", []);
      assert.equal(getPage(db, PAGE.mind, PAGE.file), null);

      publish("mimsy", "notes/tideline.md", "different-writing");
      assert.equal(await getPresence(db, getUser, PAGE, "mimsy"), null);
    });
  });
});
