import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { getOrCreateSystemUser, verifyUser } from "../packages/daemon/src/lib/auth.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { validateMindName } from "../packages/daemon/src/lib/registry.js";
import {
  conversationParticipants,
  conversations,
  messages,
  users,
} from "../packages/daemon/src/lib/schema.js";
import {
  ensureSystemDM,
  generateSystemReply,
  resetSystemDMCache,
  sendSystemMessage,
  sendSystemMessageDirect,
} from "../packages/daemon/src/lib/system-chat.js";

const { eq } = await import("drizzle-orm");

const TEST_USERNAMES = ["volute", "testmind", "mind1", "mind2"];

async function cleanup() {
  resetSystemDMCache();
  const db = await getDb();
  for (const username of TEST_USERNAMES) {
    await db.delete(users).where(eq(users.username, username));
  }
}

describe("system user", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("getOrCreateSystemUser creates user with correct fields", async () => {
    const user = await getOrCreateSystemUser();
    assert.equal(user.username, "volute");
    assert.equal(user.user_type, "system");
    assert.equal(user.display_name, "volute");
    assert.equal(user.role, "system");
  });

  it("getOrCreateSystemUser is idempotent", async () => {
    const user1 = await getOrCreateSystemUser();
    const user2 = await getOrCreateSystemUser();
    assert.equal(user1.id, user2.id);
  });

  it("system user cannot log in", async () => {
    await getOrCreateSystemUser();
    const result = await verifyUser("volute", "anything");
    assert.equal(result, null);
  });

  it("'volute' is a reserved mind name", () => {
    const err = validateMindName("volute");
    assert.ok(err, "should reject 'volute' as a mind name");
    assert.ok(err!.includes("reserved"));
  });
});

describe("system DM", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("ensureSystemDM creates DM conversation", async () => {
    const { conversationId } = await ensureSystemDM("testmind");
    assert.ok(conversationId, "should return a conversation ID");

    const db = await getDb();
    const conv = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .get();
    assert.ok(conv, "conversation should exist in DB");
    assert.equal(conv!.type, "dm");

    // Should have 2 participants
    const parts = await db
      .select()
      .from(conversationParticipants)
      .where(eq(conversationParticipants.conversation_id, conversationId))
      .all();
    assert.equal(parts.length, 2);
  });

  it("ensureSystemDM is idempotent", async () => {
    const { conversationId: id1 } = await ensureSystemDM("testmind");
    const { conversationId: id2 } = await ensureSystemDM("testmind");
    assert.equal(id1, id2);
  });

  it("ensureSystemDM creates separate DMs per mind", async () => {
    const { conversationId: id1 } = await ensureSystemDM("mind1");
    const { conversationId: id2 } = await ensureSystemDM("mind2");
    assert.notEqual(id1, id2);
  });

  it("ensureSystemDM finds existing DM after cache clear", async () => {
    const { conversationId: id1 } = await ensureSystemDM("testmind");
    resetSystemDMCache();
    const { conversationId: id2 } = await ensureSystemDM("testmind");
    assert.equal(id1, id2, "should find existing DM via DB lookup");
  });
});

describe("system messages", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("sendSystemMessageDirect persists message to conversation", async () => {
    const { conversationId } = await sendSystemMessageDirect("testmind", "hello from system");

    const db = await getDb();
    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.conversation_id, conversationId))
      .all();
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].sender_name, "volute");
    assert.equal(msgs[0].role, "user");
    assert.ok(msgs[0].content.includes("hello from system"));
  });

  it("sendSystemMessage persists message and calls delivery pipeline", async () => {
    // deliverMessage gracefully handles non-existent minds (logs warning, returns)
    await sendSystemMessage("testmind", "scheduled reminder");

    const { conversationId } = await ensureSystemDM("testmind");
    const db = await getDb();
    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.conversation_id, conversationId))
      .all();
    assert.ok(msgs.length >= 1, "message should be persisted");
    const systemMsg = msgs.find((m) => m.content.includes("scheduled reminder"));
    assert.ok(systemMsg, "should find the system message");
    assert.equal(systemMsg!.sender_name, "volute");
    assert.equal(systemMsg!.role, "user");
  });
});

describe("generateSystemReply", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("persists fallback message when no AI model is configured", async () => {
    const { conversationId } = await ensureSystemDM("testmind");

    // No AI model configured in test env, so aiComplete returns null
    await generateSystemReply(conversationId, "testmind", "hello volute");

    const db = await getDb();
    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.conversation_id, conversationId))
      .all();
    const fallback = msgs.find((m) => m.role === "assistant" && m.sender_name === "volute");
    assert.ok(fallback, "should persist a fallback reply");
    assert.ok(
      fallback!.content.includes("no AI model is configured"),
      "fallback should explain the issue",
    );
  });
});
