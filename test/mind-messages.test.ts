import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../src/lib/db.js";
import { mindHistory } from "../src/lib/schema.js";

describe("mind_history", () => {
  async function cleanup() {
    const db = await getDb();
    await db.delete(mindHistory);
  }

  it("inserts and retrieves messages", async () => {
    await cleanup();
    try {
      const db = await getDb();
      await db.insert(mindHistory).values({
        mind: "test-mind",
        channel: "volute:test-conv",
        sender: "alice",
        type: "inbound",
        content: "Hello mind",
      });
      await db.insert(mindHistory).values({
        mind: "test-mind",
        channel: "volute:test-conv",
        sender: "test-mind",
        type: "outbound",
        content: "Hello alice!",
      });

      const rows = await db
        .select()
        .from(mindHistory)
        .where(eq(mindHistory.mind, "test-mind"))
        .orderBy(mindHistory.id);

      assert.equal(rows.length, 2);
      assert.equal(rows[0].sender, "alice");
      assert.equal(rows[0].content, "Hello mind");
      assert.equal(rows[0].type, "inbound");
      assert.equal(rows[1].sender, "test-mind");
      assert.equal(rows[1].content, "Hello alice!");
      assert.equal(rows[1].type, "outbound");
    } finally {
      await cleanup();
    }
  });

  it("queries by mind name", async () => {
    await cleanup();
    try {
      const db = await getDb();
      await db.insert(mindHistory).values([
        {
          mind: "mind-a",
          channel: "volute:test-conv",
          sender: "alice",
          type: "inbound",
          content: "msg1",
        },
        {
          mind: "mind-b",
          channel: "volute:test-conv",
          sender: "bob",
          type: "inbound",
          content: "msg2",
        },
        {
          mind: "mind-a",
          channel: "volute:test-conv",
          sender: "mind-a",
          type: "outbound",
          content: "msg3",
        },
      ]);

      const rows = await db
        .select()
        .from(mindHistory)
        .where(eq(mindHistory.mind, "mind-a"))
        .orderBy(mindHistory.id);

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
      await db.insert(mindHistory).values([
        {
          mind: "mind-a",
          channel: "volute:test-conv",
          sender: "alice",
          type: "inbound",
          content: "web-msg",
        },
        {
          mind: "mind-a",
          channel: "discord",
          sender: "bob",
          type: "inbound",
          content: "discord-msg",
        },
        {
          mind: "mind-a",
          channel: "volute:test-conv",
          sender: "mind-a",
          type: "outbound",
          content: "web-reply",
        },
      ]);

      const rows = await db
        .select()
        .from(mindHistory)
        .where(and(eq(mindHistory.mind, "mind-a"), eq(mindHistory.channel, "discord")));

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
        await db.insert(mindHistory).values({
          mind: "mind-page",
          channel: "volute:test-conv",
          sender: "alice",
          type: "inbound",
          content: `msg-${i}`,
        });
      }

      // Get first page (limit 2)
      const page1 = await db
        .select()
        .from(mindHistory)
        .where(eq(mindHistory.mind, "mind-page"))
        .orderBy(desc(mindHistory.created_at))
        .limit(2)
        .offset(0);

      assert.equal(page1.length, 2);

      // Get second page (limit 2, offset 2)
      const page2 = await db
        .select()
        .from(mindHistory)
        .where(eq(mindHistory.mind, "mind-page"))
        .orderBy(desc(mindHistory.created_at))
        .limit(2)
        .offset(2);

      assert.equal(page2.length, 2);

      // Get third page (limit 2, offset 4) — only 1 remaining
      const page3 = await db
        .select()
        .from(mindHistory)
        .where(eq(mindHistory.mind, "mind-page"))
        .orderBy(desc(mindHistory.created_at))
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

  it("filters by event type", async () => {
    await cleanup();
    try {
      const db = await getDb();
      await db.insert(mindHistory).values([
        { mind: "mind-a", type: "inbound", content: "hello", sender: "alice" },
        { mind: "mind-a", type: "text", content: "thinking..." },
        {
          mind: "mind-a",
          type: "tool_use",
          content: "{}",
          metadata: JSON.stringify({ name: "read" }),
        },
        { mind: "mind-a", type: "outbound", content: "reply", sender: "mind-a" },
      ]);

      const rows = await db
        .select()
        .from(mindHistory)
        .where(and(eq(mindHistory.mind, "mind-a"), eq(mindHistory.type, "text")));

      assert.equal(rows.length, 1);
      assert.equal(rows[0].content, "thinking...");
    } finally {
      await cleanup();
    }
  });
});
