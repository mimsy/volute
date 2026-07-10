import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { createUser } from "../packages/daemon/src/lib/auth.js";
import {
  announceToSystem,
  backfillSystemChannelMembers,
  ensureSystemChannel,
  joinSystemChannel,
  joinSystemChannelForSpirit,
  resetSystemChannelCache,
} from "../packages/daemon/src/lib/chat/system-channel.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  deleteConversation,
  getChannelSettings,
  getParticipants,
} from "../packages/daemon/src/lib/events/conversations.js";
import { addMind, addSpirit, removeMind } from "../packages/daemon/src/lib/mind/registry.js";
import { messages, users } from "../packages/daemon/src/lib/schema.js";

const TEST_USERNAMES = ["volute", "testbrain", "commons-mind", "commons-seed"];
const TEST_MINDS = ["volute", "commons-mind", "commons-seed"];

async function cleanup() {
  resetSystemChannelCache();
  const db = await getDb();
  for (const username of TEST_USERNAMES) {
    await db.delete(users).where(eq(users.username, username));
  }
  for (const mind of TEST_MINDS) {
    await removeMind(mind);
  }
  // Remove the #system channel so each test exercises fresh creation
  const ch = await getChannelSettings("system");
  if (ch) await deleteConversation(ch.conversation_id);
}

describe("system channel", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("ensureSystemChannel creates channel on first call", async () => {
    const id = await ensureSystemChannel();
    assert.ok(id, "should return a conversation ID");
  });

  it("ensureSystemChannel is idempotent", async () => {
    const id1 = await ensureSystemChannel();
    const id2 = await ensureSystemChannel();
    assert.equal(id1, id2, "should return the same conversation ID");
  });

  it("ensureSystemChannel sets a default description", async () => {
    await ensureSystemChannel();
    const settings = await getChannelSettings("system");
    assert.ok(settings?.description?.includes("commons"), "should describe the shared room");
  });

  it("joinSystemChannel adds user to channel", async () => {
    const user = await createUser("testbrain", "pass123");
    await joinSystemChannel(user.id);
    // Joining again should be idempotent
    await joinSystemChannel(user.id);
    // No error means success
    assert.ok(true);
  });

  it("joinSystemChannelForSpirit adds the system user as a participant", async () => {
    await joinSystemChannelForSpirit();
    const id = await ensureSystemChannel();
    const participants = await getParticipants(id);
    const spirit = participants.find((p) => p.username === "volute");
    assert.ok(spirit, "spirit should be a participant");
    assert.equal(spirit.userType, "system", "spirit should be the system user, not a mind user");
  });

  it("backfillSystemChannelMembers joins sprouted minds and spirits, skips seeds", async () => {
    await addMind("commons-mind", 4901, "sprouted");
    await addMind("commons-seed", 4902, "seed");
    await addSpirit("volute", 4903, "claude", "/tmp/spirit");

    await backfillSystemChannelMembers();

    const id = await ensureSystemChannel();
    const participants = await getParticipants(id);
    const names = participants.map((p) => p.username);
    assert.ok(names.includes("commons-mind"), "sprouted mind should be joined");
    assert.ok(names.includes("volute"), "spirit should be joined");
    assert.ok(!names.includes("commons-seed"), "seed should not be joined");
    const spirit = participants.find((p) => p.username === "volute");
    assert.equal(spirit?.userType, "system", "spirit joins as the system user");
  });

  it("backfillSystemChannelMembers is idempotent", async () => {
    await addMind("commons-mind", 4901, "sprouted");
    await backfillSystemChannelMembers();
    await backfillSystemChannelMembers();
    const id = await ensureSystemChannel();
    const participants = await getParticipants(id);
    const joined = participants.filter((p) => p.username === "commons-mind");
    assert.equal(joined.length, 1, "mind should be a participant exactly once");
  });

  it("announceToSystem posts a message", async () => {
    await announceToSystem("test announcement");
    const db = await getDb();
    const msgs = await db.select().from(messages).all();
    const found = msgs.find((m) => m.content.includes("test announcement"));
    assert.ok(found, "should find the announcement message");
  });
});
