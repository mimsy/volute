import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { createUser } from "../packages/daemon/src/lib/auth.js";
import {
  announceSprout,
  announceToSystem,
  backfillSystemChannelMembers,
  ensureSystemChannel,
  joinSystemChannel,
  joinSystemChannelForMind,
  joinSystemChannelForSpirit,
  resetSystemChannelCache,
} from "../packages/daemon/src/lib/chat/system-channel.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  createChannel,
  deleteConversation,
  getChannelSettings,
  getParticipants,
} from "../packages/daemon/src/lib/events/conversations.js";
import {
  addMind,
  addSpirit,
  addVariant,
  removeMind,
} from "../packages/daemon/src/lib/mind/registry.js";
import {
  activity,
  messages,
  mindHistory,
  systemEvents,
  users,
} from "../packages/daemon/src/lib/schema.js";

const TEST_USERNAMES = [
  "volute",
  "testbrain",
  "commons-mind",
  "commons-seed",
  "commons-legacy",
  "commons-clash",
  "commons-sprout",
];
const TEST_MINDS = [
  "volute",
  "commons-mind",
  "commons-seed",
  "commons-legacy",
  "commons-clash",
  "commons-mind-v1",
  "commons-sprout",
];

async function cleanup() {
  resetSystemChannelCache();
  const db = await getDb();
  for (const username of TEST_USERNAMES) {
    await db.delete(users).where(eq(users.username, username));
  }
  for (const mind of TEST_MINDS) {
    await db.delete(activity).where(eq(activity.mind, mind));
    await db.delete(mindHistory).where(eq(mindHistory.mind, mind));
    await db.delete(systemEvents).where(eq(systemEvents.mind, mind));
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

  it("ensureSystemChannel fills in the description for a pre-existing bare channel", async () => {
    await createChannel("system"); // legacy channel, no description
    await ensureSystemChannel();
    const settings = await getChannelSettings("system");
    assert.ok(settings?.description?.includes("commons"), "should backfill the description");
  });

  it("ensureSystemChannel never clobbers a host-set description", async () => {
    await createChannel("system", undefined, { description: "our house rules" });
    await ensureSystemChannel();
    const settings = await getChannelSettings("system");
    assert.equal(settings?.description, "our house rules");
  });

  it("joinSystemChannel adds user to channel", async () => {
    const user = await createUser("testbrain", "pass123");
    await joinSystemChannel(user.id);
    // Joining again should be idempotent
    await joinSystemChannel(user.id);
    const id = await ensureSystemChannel();
    const participants = await getParticipants(id);
    const joined = participants.filter((p) => p.username === "testbrain");
    assert.equal(joined.length, 1, "user should be a participant exactly once");
  });

  it("joinSystemChannelForSpirit adds the system user as a participant", async () => {
    await joinSystemChannelForSpirit();
    const id = await ensureSystemChannel();
    const participants = await getParticipants(id);
    const spirit = participants.find((p) => p.username === "volute");
    assert.ok(spirit, "spirit should be a participant");
    assert.equal(spirit.userType, "system", "spirit should be the system user, not a mind user");
  });

  it("backfillSystemChannelMembers joins sprouted minds and spirits, skips seeds and variants", async () => {
    await addMind("commons-mind", 4901, "sprouted");
    await addMind("commons-seed", 4902, "seed");
    await addMind("commons-legacy", 4903); // pre-stage-field mind: stage null → sprouted
    await addSpirit("volute", 4904, "claude", "/tmp/spirit");
    await addVariant("commons-mind-v1", "commons-mind", 4905, "/tmp/variant", "variant-branch");

    await backfillSystemChannelMembers();

    const id = await ensureSystemChannel();
    const participants = await getParticipants(id);
    const names = participants.map((p) => p.username);
    assert.ok(names.includes("commons-mind"), "sprouted mind should be joined");
    assert.ok(names.includes("commons-legacy"), "legacy mind without stage should be joined");
    assert.ok(names.includes("volute"), "spirit should be joined");
    assert.ok(!names.includes("commons-seed"), "seed should not be joined");
    assert.ok(!names.includes("commons-mind-v1"), "variant should not be joined");
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

  it("backfillSystemChannelMembers keeps going when one entry fails", async () => {
    // A brain user squatting on a mind's name makes getOrCreateMindUser throw
    await createUser("commons-clash", "pass123");
    await addMind("commons-clash", 4901, "sprouted");
    await addMind("commons-mind", 4902, "sprouted");

    await backfillSystemChannelMembers(); // must not throw

    const id = await ensureSystemChannel();
    const participants = await getParticipants(id);
    const names = participants.map((p) => p.username);
    assert.ok(names.includes("commons-mind"), "later entries should still be joined");
    assert.ok(!names.includes("commons-clash"), "failed entry should not be joined");
  });

  it("announceToSystem posts a sender-less event row, never the spirit's voice (#687)", async () => {
    await announceToSystem("test announcement");
    const db = await getDb();
    const msgs = await db.select().from(messages).all();
    const found = msgs.find((m) => m.content.includes("test announcement"));
    assert.ok(found, "should find the announcement message");
    assert.equal(found!.role, "event", "announcement should be an event, not a chat message");
    assert.equal(
      found!.sender_name,
      null,
      "announcement must have no sender so it isn't attributed to the spirit",
    );
  });

  it("announceToSystem delivers a sender-less commons event to mind participants (#687)", async () => {
    await addMind("commons-mind", 4901, "sprouted");
    await joinSystemChannelForMind("commons-mind");

    await announceToSystem("atlas has joined");

    // deliverEvent inserts the event row; as a next-turn event it stays pending until the
    // mind's next turn drains it as an [Events] block. It must be a `commons` event, not a
    // message attributed to the spirit.
    const db = await getDb();
    const events = await db
      .select()
      .from(systemEvents)
      .where(eq(systemEvents.mind, "commons-mind"))
      .all();
    const event = events.find((e) => e.body.includes("atlas has joined"));
    assert.ok(event, "mind participant should receive the announcement as a system event");
    assert.equal(event!.type, "commons", "announcement should be delivered as a commons event");
    assert.equal(
      event!.delivery,
      "next-turn",
      "ambient commons announcements should fold into the next turn, not interrupt per event",
    );
  });

  // Register the spirit (dead port — the event stays pending, which is fine: the
  // prompt is a durable system event redelivered on the spirit's next start).
  async function registerSpirit(): Promise<void> {
    await addSpirit("volute", 4906, "claude", "/tmp/spirit");
  }

  it("announceSprout prompts the spirit to write the welcome and records a mind_sprouted activity", async () => {
    // The spirit hand-writes the #system welcome (#665); the daemon only sends
    // it a prompt — now a lifecycle system event, not a DM.
    await registerSpirit();

    await announceSprout("commons-sprout");

    const db = await getDb();
    const events = await db
      .select()
      .from(systemEvents)
      .where(eq(systemEvents.mind, "volute"))
      .all();
    const prompt = events.find((e) => e.body.includes("@commons-sprout"));
    assert.ok(prompt, "spirit should receive an event prompting it to welcome the sprouted mind");
    assert.ok(prompt!.body.includes("#system"), "prompt should point the spirit at #system");
    assert.equal(prompt!.type, "lifecycle");

    // No canned message is posted anywhere — the spirit composes its own.
    const msgs = await db.select().from(messages).all();
    const canned = msgs.find((m) => m.content.includes("commons-sprout"));
    assert.equal(canned, undefined, "no templated welcome should be posted");

    const acts = await db.select().from(activity).where(eq(activity.mind, "commons-sprout")).all();
    const sprouted = acts.find((a) => a.type === "mind_sprouted");
    assert.ok(sprouted, "should publish a mind_sprouted activity event");
    assert.ok(sprouted?.summary.includes("sprouted"), "activity summary should mention sprouting");
  });

  it("announceSprout still records the activity event when the spirit is unavailable", async () => {
    // No spirit registered — the prompt can't be delivered. There's deliberately
    // no canned fallback, but the deterministic feed card must still fire.
    await announceSprout("commons-sprout");

    const db = await getDb();
    const acts = await db.select().from(activity).where(eq(activity.mind, "commons-sprout")).all();
    const sprouted = acts.find((a) => a.type === "mind_sprouted");
    assert.ok(sprouted, "mind_sprouted activity should fire even without a spirit");
  });

  it("announceSprout uses the mind's display name when set", async () => {
    // The real sprout flow joins the mind to #system (creating its user row)
    // before announcing, so the display-name branch is the production path.
    const db = await getDb();
    await db.insert(users).values({
      username: "commons-sprout",
      password_hash: "!mind",
      role: "user",
      user_type: "mind",
      display_name: "Sprouty",
    });
    await registerSpirit();

    await announceSprout("commons-sprout");

    const events = await db
      .select()
      .from(systemEvents)
      .where(eq(systemEvents.mind, "volute"))
      .all();
    const prompt = events.find((e) => e.body.includes("Sprouty"));
    assert.ok(prompt, "spirit prompt should use the display name");

    const acts = await db.select().from(activity).where(eq(activity.mind, "commons-sprout")).all();
    const sprouted = acts.find((a) => a.type === "mind_sprouted");
    assert.equal(sprouted?.summary, "Sprouty sprouted");
  });
});
