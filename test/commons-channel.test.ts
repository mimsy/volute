import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import { createUser } from "../packages/daemon/src/lib/auth.js";
import {
  announceSprout,
  announceToCommons,
  backfillCommonsChannelMembers,
  ensureCommonsChannel,
  joinCommonsChannel,
  joinCommonsChannelForMind,
  joinCommonsChannelForSpirit,
  resetCommonsChannelCache,
} from "../packages/daemon/src/lib/chat/commons-channel.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { clearConfigCache } from "../packages/daemon/src/lib/delivery/delivery-router.js";
import {
  createChannel,
  deleteConversation,
  getChannelSettings,
  getDefaultChannelRow,
  getParticipants,
  markChannelDefault,
} from "../packages/daemon/src/lib/events/conversations.js";
import {
  addMind,
  addSpirit,
  addVariant,
  removeMind,
} from "../packages/daemon/src/lib/mind/registry.js";
import {
  activity,
  channels,
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

/** Write a routes.json for a test mind so its commons routing decision is deterministic. */
function writeCommonsRoutes(name: string, config: object): void {
  const configDir = resolve(process.env.VOLUTE_HOME!, "minds", name, "home/.config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(resolve(configDir, "routes.json"), JSON.stringify(config));
  clearConfigCache(name);
}

async function cleanup() {
  resetCommonsChannelCache();
  clearConfigCache();
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
  // Remove every channel so each test exercises fresh creation / resolution.
  for (const ch of await db.select().from(channels).all()) {
    await deleteConversation(ch.conversation_id);
  }
}

describe("commons channel", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("ensureCommonsChannel creates channel on first call", async () => {
    const id = await ensureCommonsChannel();
    assert.ok(id, "should return a conversation ID");
  });

  it("ensureCommonsChannel is idempotent", async () => {
    const id1 = await ensureCommonsChannel();
    const id2 = await ensureCommonsChannel();
    assert.equal(id1, id2, "should return the same conversation ID");
  });

  it("a fresh install's commons is named #commons and carries the default marker", async () => {
    await ensureCommonsChannel();
    const row = await getDefaultChannelRow();
    assert.ok(row, "the default channel should be resolvable by its marker");
    assert.equal(row!.name, "commons", "new installs get a channel named 'commons'");
    assert.equal(row!.is_default, 1, "and it is marked default");
  });

  it("resolves the default channel by marker, not by name — a renamed house keeps its commons", async () => {
    // A house that renamed its commons long ago: a channel named "town-square",
    // carrying the default marker. ensureCommonsChannel must resolve THIS, never go
    // hunting for a channel literally named "commons" (which would strand the real
    // commons and spin up a duplicate). This is the guard against the default
    // reverting to a name-based lookup.
    const legacy = await createChannel("town-square");
    await markChannelDefault(legacy.id);
    resetCommonsChannelCache();

    const id = await ensureCommonsChannel();
    assert.equal(id, legacy.id, "must resolve the marked channel regardless of its name");

    const db = await getDb();
    const chans = await db.select().from(channels).all();
    assert.equal(chans.length, 1, "must not create a second channel");
    assert.equal(chans[0].name, "town-square", "the earned name is left untouched");
  });

  it("ensureCommonsChannel sets a default description", async () => {
    await ensureCommonsChannel();
    const row = await getDefaultChannelRow();
    assert.ok(row?.description?.includes("commons"), "should describe the shared room");
  });

  it("ensureCommonsChannel fills in the description for a pre-existing bare default channel", async () => {
    // A legacy default channel (any name) with no description — the migration backfills
    // the marker; ensureCommonsChannel then backfills the description.
    const legacy = await createChannel("system"); // legacy name, no description
    await markChannelDefault(legacy.id);
    resetCommonsChannelCache();
    await ensureCommonsChannel();
    const settings = await getChannelSettings("system");
    assert.ok(settings?.description?.includes("commons"), "should backfill the description");
  });

  it("ensureCommonsChannel never clobbers a host-set description", async () => {
    const legacy = await createChannel("system", undefined, { description: "our house rules" });
    await markChannelDefault(legacy.id);
    resetCommonsChannelCache();
    await ensureCommonsChannel();
    const settings = await getChannelSettings("system");
    assert.equal(settings?.description, "our house rules");
  });

  it("joinCommonsChannel adds user to channel", async () => {
    const user = await createUser("testbrain", "pass123");
    await joinCommonsChannel(user.id);
    // Joining again should be idempotent
    await joinCommonsChannel(user.id);
    const id = await ensureCommonsChannel();
    const participants = await getParticipants(id);
    const joined = participants.filter((p) => p.username === "testbrain");
    assert.equal(joined.length, 1, "user should be a participant exactly once");
  });

  it("joinCommonsChannelForSpirit adds the system user as a participant", async () => {
    await joinCommonsChannelForSpirit();
    const id = await ensureCommonsChannel();
    const participants = await getParticipants(id);
    const spirit = participants.find((p) => p.username === "volute");
    assert.ok(spirit, "spirit should be a participant");
    assert.equal(spirit.userType, "spirit", "spirit should be the system user, not a mind user");
  });

  it("backfillCommonsChannelMembers joins sprouted minds and spirits, skips seeds and variants", async () => {
    await addMind("commons-mind", 4901, "sprouted");
    await addMind("commons-seed", 4902, "seed");
    await addMind("commons-legacy", 4903); // pre-stage-field mind: stage null → sprouted
    await addSpirit("volute", 4904, "claude", "/tmp/spirit");
    await addVariant("commons-mind-v1", "commons-mind", 4905, "/tmp/variant", "variant-branch");

    await backfillCommonsChannelMembers();

    const id = await ensureCommonsChannel();
    const participants = await getParticipants(id);
    const names = participants.map((p) => p.username);
    assert.ok(names.includes("commons-mind"), "sprouted mind should be joined");
    assert.ok(names.includes("commons-legacy"), "legacy mind without stage should be joined");
    assert.ok(names.includes("volute"), "spirit should be joined");
    assert.ok(!names.includes("commons-seed"), "seed should not be joined");
    assert.ok(!names.includes("commons-mind-v1"), "variant should not be joined");
    const spirit = participants.find((p) => p.username === "volute");
    assert.equal(spirit?.userType, "spirit", "spirit joins as the system user");
  });

  it("backfillCommonsChannelMembers is idempotent", async () => {
    await addMind("commons-mind", 4901, "sprouted");
    await backfillCommonsChannelMembers();
    await backfillCommonsChannelMembers();
    const id = await ensureCommonsChannel();
    const participants = await getParticipants(id);
    const joined = participants.filter((p) => p.username === "commons-mind");
    assert.equal(joined.length, 1, "mind should be a participant exactly once");
  });

  it("backfillCommonsChannelMembers keeps going when one entry fails", async () => {
    // A brain user squatting on a mind's name makes getOrCreateMindUser throw
    await createUser("commons-clash", "pass123");
    await addMind("commons-clash", 4901, "sprouted");
    await addMind("commons-mind", 4902, "sprouted");

    await backfillCommonsChannelMembers(); // must not throw

    const id = await ensureCommonsChannel();
    const participants = await getParticipants(id);
    const names = participants.map((p) => p.username);
    assert.ok(names.includes("commons-mind"), "later entries should still be joined");
    assert.ok(!names.includes("commons-clash"), "failed entry should not be joined");
  });

  it("announceToCommons posts a sender-less event row, never the spirit's voice (#687)", async () => {
    await announceToCommons("test announcement");
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

  it("announceToCommons delivers to mind participants sender-less on the channel path (#687)", async () => {
    await addMind("commons-mind", 4901, "sprouted");
    await joinCommonsChannelForMind("commons-mind");
    // Disable gating so the (dead-port) delivery still records the inbound: the mind never acks,
    // but recordInbound runs first on the normal channel path and captures the delivered shape.
    writeCommonsRoutes("commons-mind", { gateUnmatched: false });

    await announceToCommons("atlas has joined");

    // Delivery is fire-and-forget inside announceToCommons, so poll for the recorded inbound.
    const db = await getDb();
    let row: { sender: string | null; channel: string | null } | undefined;
    for (let i = 0; i < 50 && !row; i++) {
      const inbound = await db
        .select()
        .from(mindHistory)
        .where(and(eq(mindHistory.mind, "commons-mind"), eq(mindHistory.type, "inbound")))
        .all();
      row = inbound.find((r) => r.content?.includes("atlas has joined"));
      if (!row) await new Promise((res) => setTimeout(res, 20));
    }
    assert.ok(row, "the announcement should be delivered to the mind participant");
    assert.equal(row!.sender, null, "delivery must be sender-less — never the spirit");
    assert.equal(
      row!.channel,
      "#commons",
      "delivered on the #commons channel, following its routing",
    );

    // And it must NOT go out as a system event any more — announcements are channel messages.
    const events = await db
      .select()
      .from(systemEvents)
      .where(eq(systemEvents.mind, "commons-mind"))
      .all();
    assert.equal(events.length, 0, "announcements are channel messages, not system events");
  });

  it("announceToCommons delivers to the spirit participant, sender-less (#817)", async () => {
    // The commons is the spirit's room, so it must perceive announcements there too.
    // The spirit is a `user_type: "spirit"` participant that `isMind` excludes; delivery
    // must still reach it — on the same sender-less channel path minds get — because
    // removing that inclusion is exactly the regression this guards.
    await addSpirit("volute", 4906, "claude", "/tmp/spirit");
    await joinCommonsChannelForSpirit();
    await addMind("commons-mind", 4901, "sprouted");
    await joinCommonsChannelForMind("commons-mind");
    // Disable gating so the (dead-port) delivery still records the inbound for both.
    writeCommonsRoutes("volute", { gateUnmatched: false });
    writeCommonsRoutes("commons-mind", { gateUnmatched: false });

    await announceToCommons("atlas has joined");

    // Delivery is fire-and-forget; poll for the spirit's recorded inbound.
    const db = await getDb();
    let spiritRow: { sender: string | null; channel: string | null } | undefined;
    for (let i = 0; i < 50 && !spiritRow; i++) {
      const inbound = await db
        .select()
        .from(mindHistory)
        .where(and(eq(mindHistory.mind, "volute"), eq(mindHistory.type, "inbound")))
        .all();
      spiritRow = inbound.find((r) => r.content?.includes("atlas has joined"));
      if (!spiritRow) await new Promise((res) => setTimeout(res, 20));
    }
    assert.ok(spiritRow, "the announcement should be delivered to the spirit participant");
    assert.equal(
      spiritRow!.sender,
      null,
      "spirit delivery must be sender-less — not its own voice",
    );
    assert.equal(spiritRow!.channel, "#commons", "delivered on the #commons channel");

    // Mind delivery is unchanged: the mind participant still receives it too.
    const mindInbound = await db
      .select()
      .from(mindHistory)
      .where(and(eq(mindHistory.mind, "commons-mind"), eq(mindHistory.type, "inbound")))
      .all();
    assert.ok(
      mindInbound.some((r) => r.content?.includes("atlas has joined")),
      "mind participants still receive the announcement",
    );
  });

  it("announceToCommons follows a renamed default channel's slug", async () => {
    // A house kept a proper name on its commons. The delivered routing slug must
    // track that name, not a hardcoded "#commons".
    const legacy = await createChannel("system");
    await markChannelDefault(legacy.id);
    resetCommonsChannelCache();
    await addMind("commons-mind", 4901, "sprouted");
    await joinCommonsChannelForMind("commons-mind");
    writeCommonsRoutes("commons-mind", { gateUnmatched: false });

    await announceToCommons("atlas has joined");

    const db = await getDb();
    let row: { channel: string | null } | undefined;
    for (let i = 0; i < 50 && !row; i++) {
      const inbound = await db
        .select()
        .from(mindHistory)
        .where(and(eq(mindHistory.mind, "commons-mind"), eq(mindHistory.type, "inbound")))
        .all();
      row = inbound.find((r) => (r as { content: string | null }).content?.includes("atlas"));
      if (!row) await new Promise((res) => setTimeout(res, 20));
    }
    assert.ok(row, "delivered to the mind");
    assert.equal(row!.channel, "#system", "routing slug follows the channel's actual name");
  });

  // Register the spirit (dead port — the event stays pending, which is fine: the
  // prompt is a durable system event redelivered on the spirit's next start).
  async function registerSpirit(): Promise<void> {
    await addSpirit("volute", 4906, "claude", "/tmp/spirit");
  }

  it("announceSprout prompts the spirit to write the welcome and records a mind_sprouted activity", async () => {
    // The spirit hand-writes the commons welcome (#665); the daemon only sends
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
    assert.ok(prompt!.body.includes("#commons"), "prompt should point the spirit at the commons");
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
    // The real sprout flow joins the mind to the commons (creating its user row)
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
