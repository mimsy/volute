import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { getOrCreateSystemUser, verifyUser } from "../packages/daemon/src/lib/auth.js";
import { ensureSystemDM, resetSystemDMCache } from "../packages/daemon/src/lib/chat/system-chat.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { validateMindName } from "../packages/daemon/src/lib/mind/registry.js";
import {
  conversationParticipants,
  conversations,
  mindHistory,
  minds,
  users,
} from "../packages/daemon/src/lib/schema.js";

const TEST_USERNAMES = ["volute", "testmind", "mind1", "mind2"];

async function cleanup() {
  resetSystemDMCache();
  const db = await getDb();
  for (const username of TEST_USERNAMES) {
    await db.delete(users).where(eq(users.username, username));
    await db.delete(mindHistory).where(eq(mindHistory.mind, username));
  }
  await db.delete(minds).where(eq(minds.name, "volute"));
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

// The spirit↔mind DM bootstrap survives the system-events refactor: automated traffic now
// goes through system events, but the genuine correspondence DM is still created on demand.
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

  it("ensureSystemDM is a no-op for the spirit (can't DM the shared system user)", async () => {
    // The spirit shares the system user, so there's no distinct pair to DM. It returns
    // null rather than throwing, so `startMindFull` doesn't log an error on spirit start (#688).
    const result = await ensureSystemDM("volute");
    assert.equal(result, null, "should return null for the spirit, not throw");
  });
});
