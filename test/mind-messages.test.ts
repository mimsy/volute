import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../src/lib/db.js";
import { mindMessages } from "../src/lib/schema.js";

describe("mind_messages", () => {
  async function cleanup() {
    const db = await getDb();
    await db.delete(mindMessages);
  }

  it("inserts and retrieves messages", async () => {
    await cleanup();
    try {
      const db = await getDb();
      await db.insert(mindMessages).values({
        mind: "test-mind",
        channel: "volute:test-conv",
        sender: "alice",
        content: "Hello mind",
      });
      await db.insert(mindMessages).values({
        mind: "test-mind",
        channel: "volute:test-conv",
        sender: "test-mind",
        content: "Hello alice!",
      });

      const rows = await db
        .select()
        .from(mindMessages)
        .where(eq(mindMessages.mind, "test-mind"))
        .orderBy(mindMessages.id);

      assert.equal(rows.length, 2);
      assert.equal(rows[0].sender, "alice");
      assert.equal(rows[0].content, "Hello mind");
      assert.equal(rows[1].sender, "test-mind");
      assert.equal(rows[1].content, "Hello alice!");
    } finally {
      await cleanup();
    }
  });

  it("queries by mind name", async () => {
    await cleanup();
    try {
      const db = await getDb();
      await db.insert(mindMessages).values([
        { mind: "mind-a", channel: "volute:test-conv", sender: "alice", content: "msg1" },
        { mind: "mind-b", channel: "volute:test-conv", sender: "bob", content: "msg2" },
        { mind: "mind-a", channel: "volute:test-conv", sender: "mind-a", content: "msg3" },
      ]);

      const rows = await db
        .select()
        .from(mindMessages)
        .where(eq(mindMessages.mind, "mind-a"))
        .orderBy(mindMessages.id);

      assert.equal(rows.length, 2);
      assert.equal(rows[0].content, "msg1");
      assert.equal(rows[1].content, "msg3");
    } finally {
      await cleanup();
    }
  });

  it("filters by channel", async () => {
    await cleanup();
    try {
      const db = await getDb();
      await db.insert(mindMessages).values([
        { mind: "mind-a", channel: "volute:test-conv", sender: "alice", content: "web-msg" },
        { mind: "mind-a", channel: "discord", sender: "bob", content: "discord-msg" },
        {
          mind: "mind-a",
          channel: "volute:test-conv",
          sender: "mind-a",
          content: "web-reply",
        },
      ]);

      const rows = await db
        .select()
        .from(mindMessages)
        .where(and(eq(mindMessages.mind, "mind-a"), eq(mindMessages.channel, "discord")));

      assert.equal(rows.length, 1);
      assert.equal(rows[0].content, "discord-msg");
    } finally {
      await cleanup();
    }
  });

  it("supports pagination with limit and offset", async () => {
    await cleanup();
    try {
      const db = await getDb();
      // Insert 5 messages
      for (let i = 1; i <= 5; i++) {
        await db.insert(mindMessages).values({
          mind: "mind-page",
          channel: "volute:test-conv",
          sender: "alice",
          content: `msg-${i}`,
        });
      }

      // Get first page (limit 2)
      const page1 = await db
        .select()
        .from(mindMessages)
        .where(eq(mindMessages.mind, "mind-page"))
        .orderBy(desc(mindMessages.created_at))
        .limit(2)
        .offset(0);

      assert.equal(page1.length, 2);

      // Get second page (limit 2, offset 2)
      const page2 = await db
        .select()
        .from(mindMessages)
        .where(eq(mindMessages.mind, "mind-page"))
        .orderBy(desc(mindMessages.created_at))
        .limit(2)
        .offset(2);

      assert.equal(page2.length, 2);

      // Get third page (limit 2, offset 4) — only 1 remaining
      const page3 = await db
        .select()
        .from(mindMessages)
        .where(eq(mindMessages.mind, "mind-page"))
        .orderBy(desc(mindMessages.created_at))
        .limit(2)
        .offset(4);

      assert.equal(page3.length, 1);

      // All pages should have distinct messages
      const allIds = [...page1, ...page2, ...page3].map((r) => r.id);
      assert.equal(new Set(allIds).size, 5);
    } finally {
      await cleanup();
    }
  });
});
