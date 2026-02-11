import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../src/lib/db.js";
import { agentMessages } from "../src/lib/schema.js";

describe("agent_messages", () => {
  async function cleanup() {
    const db = await getDb();
    await db.delete(agentMessages);
  }

  it("inserts and retrieves user and assistant messages", async () => {
    await cleanup();
    try {
      const db = await getDb();
      await db.insert(agentMessages).values({
        agent: "test-agent",
        channel: "volute:test-conv",
        role: "user",
        sender: "alice",
        content: "Hello agent",
      });
      await db.insert(agentMessages).values({
        agent: "test-agent",
        channel: "volute:test-conv",
        role: "assistant",
        content: "Hello alice!",
      });

      const rows = await db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.agent, "test-agent"))
        .orderBy(agentMessages.id);

      assert.equal(rows.length, 2);
      assert.equal(rows[0].role, "user");
      assert.equal(rows[0].sender, "alice");
      assert.equal(rows[0].content, "Hello agent");
      assert.equal(rows[1].role, "assistant");
      assert.equal(rows[1].sender, null);
      assert.equal(rows[1].content, "Hello alice!");
    } finally {
      await cleanup();
    }
  });

  it("queries by agent name", async () => {
    await cleanup();
    try {
      const db = await getDb();
      await db.insert(agentMessages).values([
        { agent: "agent-a", channel: "volute:test-conv", role: "user", content: "msg1" },
        { agent: "agent-b", channel: "volute:test-conv", role: "user", content: "msg2" },
        { agent: "agent-a", channel: "volute:test-conv", role: "assistant", content: "msg3" },
      ]);

      const rows = await db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.agent, "agent-a"))
        .orderBy(agentMessages.id);

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
      await db.insert(agentMessages).values([
        { agent: "agent-a", channel: "volute:test-conv", role: "user", content: "web-msg" },
        { agent: "agent-a", channel: "discord", role: "user", content: "discord-msg" },
        { agent: "agent-a", channel: "volute:test-conv", role: "assistant", content: "web-reply" },
      ]);

      const rows = await db
        .select()
        .from(agentMessages)
        .where(and(eq(agentMessages.agent, "agent-a"), eq(agentMessages.channel, "discord")));

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
        await db.insert(agentMessages).values({
          agent: "agent-page",
          channel: "volute:test-conv",
          role: "user",
          content: `msg-${i}`,
        });
      }

      // Get first page (limit 2)
      const page1 = await db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.agent, "agent-page"))
        .orderBy(desc(agentMessages.created_at))
        .limit(2)
        .offset(0);

      assert.equal(page1.length, 2);

      // Get second page (limit 2, offset 2)
      const page2 = await db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.agent, "agent-page"))
        .orderBy(desc(agentMessages.created_at))
        .limit(2)
        .offset(2);

      assert.equal(page2.length, 2);

      // Get third page (limit 2, offset 4) — only 1 remaining
      const page3 = await db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.agent, "agent-page"))
        .orderBy(desc(agentMessages.created_at))
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
