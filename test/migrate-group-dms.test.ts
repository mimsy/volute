import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { createUser } from "../src/lib/auth.js";
import { getDb } from "../src/lib/db.js";
import { migrateGroupDMsToChannels } from "../src/lib/events/conversations.js";
import { conversationParticipants, conversations, users } from "../src/lib/schema.js";

let testUserIds: number[] = [];

async function cleanup() {
  const db = await getDb();
  await db.delete(conversationParticipants);
  await db.delete(conversations);
  await db.delete(users);
  testUserIds = [];
}

async function ensureUsers(count: number) {
  while (testUserIds.length < count) {
    const idx = testUserIds.length;
    const user = await createUser(`migrate-test-${idx}-${randomUUID().slice(0, 8)}`, "pass");
    testUserIds.push(user.id);
  }
}

/** Insert a raw conversation row (bypasses createConversation to set arbitrary type). */
async function insertConversation(opts: {
  id: string;
  type: string;
  name?: string | null;
  title?: string | null;
}) {
  const db = await getDb();
  await db.insert(conversations).values({
    id: opts.id,
    channel: "volute",
    type: opts.type,
    name: opts.name ?? null,
    title: opts.title ?? null,
  });
}

async function addParticipants(conversationId: string, count: number) {
  await ensureUsers(count);
  const db = await getDb();
  for (let i = 0; i < count; i++) {
    await db.insert(conversationParticipants).values({
      conversation_id: conversationId,
      user_id: testUserIds[i],
      role: i === 0 ? "owner" : "member",
    });
  }
}

async function getConv(id: string) {
  const db = await getDb();
  const rows = await db.select().from(conversations).where(eq(conversations.id, id));
  return rows[0];
}

describe("migrateGroupDMsToChannels", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("converts type='group' conversations to type='channel'", async () => {
    const id = randomUUID();
    await insertConversation({ id, type: "group", title: "Project Chat" });

    await migrateGroupDMsToChannels();

    const conv = await getConv(id);
    assert.equal(conv.type, "channel");
    assert.equal(conv.name, "Project Chat");
  });

  it("uses existing name over title for migrated groups", async () => {
    const id = randomUUID();
    await insertConversation({ id, type: "group", name: "my-channel", title: "Old Title" });

    await migrateGroupDMsToChannels();

    const conv = await getConv(id);
    assert.equal(conv.type, "channel");
    assert.equal(conv.name, "my-channel");
  });

  it("leaves name null when group has no name or title", async () => {
    const id = randomUUID();
    await insertConversation({ id, type: "group" });

    await migrateGroupDMsToChannels();

    const conv = await getConv(id);
    assert.equal(conv.type, "channel");
    assert.equal(conv.name, null);
  });

  it("converts DM conversations with 3+ participants to channels", async () => {
    const id = randomUUID();
    await insertConversation({ id, type: "dm", title: "Group DM" });
    await addParticipants(id, 3);

    await migrateGroupDMsToChannels();

    const conv = await getConv(id);
    assert.equal(conv.type, "channel");
    assert.equal(conv.name, "Group DM");
  });

  it("leaves normal 2-participant DMs untouched", async () => {
    const id = randomUUID();
    await insertConversation({ id, type: "dm", title: "DM" });
    await addParticipants(id, 2);

    await migrateGroupDMsToChannels();

    const conv = await getConv(id);
    assert.equal(conv.type, "dm");
    assert.equal(conv.name, null);
  });

  it("is idempotent — running twice produces the same result", async () => {
    const id = randomUUID();
    await insertConversation({ id, type: "group", title: "Test" });

    await migrateGroupDMsToChannels();
    await migrateGroupDMsToChannels();

    const conv = await getConv(id);
    assert.equal(conv.type, "channel");
    assert.equal(conv.name, "Test");
  });

  it("handles mixed conversations correctly", async () => {
    const groupId = randomUUID();
    const dmId = randomUUID();
    const overloadedDmId = randomUUID();

    await insertConversation({ id: groupId, type: "group", title: "Group" });
    await insertConversation({ id: dmId, type: "dm" });
    await addParticipants(dmId, 2);
    await insertConversation({ id: overloadedDmId, type: "dm", title: "Big DM" });
    await addParticipants(overloadedDmId, 4);

    await migrateGroupDMsToChannels();

    const group = await getConv(groupId);
    assert.equal(group.type, "channel");
    assert.equal(group.name, "Group");

    const dm = await getConv(dmId);
    assert.equal(dm.type, "dm");

    const overloaded = await getConv(overloadedDmId);
    assert.equal(overloaded.type, "channel");
    assert.equal(overloaded.name, "Big DM");
  });
});
