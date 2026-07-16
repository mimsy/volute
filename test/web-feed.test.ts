import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { createUser, setUserRole } from "../packages/daemon/src/lib/auth.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { publish as publishActivity } from "../packages/daemon/src/lib/events/activity-events.js";
import {
  addParticipant,
  createChannel,
  createConversation,
  setConversationPrivate,
} from "../packages/daemon/src/lib/events/conversations.js";
import { getDailyDigest } from "../packages/daemon/src/lib/events/feed.js";
import {
  activity,
  conversations,
  messages,
  summaries,
  users,
} from "../packages/daemon/src/lib/schema.js";
import { getPeriodKey } from "../packages/daemon/src/lib/util/period-keys.js";
import conversationsRoute from "../packages/daemon/src/web/api/v1/conversations.js";
import feedRoute from "../packages/daemon/src/web/api/v1/feed.js";
import { createSession } from "../packages/daemon/src/web/middleware/auth.js";

function feedApp() {
  const app = new Hono();
  app.route("/api/v1/feed", feedRoute);
  return app;
}

function convApp() {
  const app = new Hono();
  app.route("/api/v1/conversations", conversationsRoute);
  return app;
}

/** A DB timestamp `minutesAgo` before now, in "YYYY-MM-DD HH:MM:SS" UTC. */
function ago(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString().replace("T", " ").slice(0, 19);
}

async function insertMsg(
  conversationId: string,
  role: string,
  sender: string | null,
  text: string,
  createdAt: string,
): Promise<void> {
  const db = await getDb();
  await db.insert(messages).values({
    conversation_id: conversationId,
    role,
    sender_name: sender,
    content: JSON.stringify([{ type: "text", text }]),
    created_at: createdAt,
  });
}

async function cleanup() {
  const db = await getDb();
  await db.delete(users).where(sql`username LIKE 'feed-test-%'`);
  await db.delete(activity).where(sql`mind LIKE 'feed-test-%'`);
  await db
    .delete(summaries)
    .where(sql`mind IN ('_system', 'system') AND content LIKE 'feed-test-%'`);
  await db.delete(summaries).where(and(eq(summaries.mind, "system"), eq(summaries.period, "day")));
  // Conversations created via createConversation/createChannel are cleaned by id below.
}

async function makeUser(name: string, role: "admin" | "user"): Promise<string> {
  const u = await createUser(name, "pass");
  await setUserRole(u.id, role);
  return createSession(u.id);
}

describe("web feed routes", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("401 without a session", async () => {
    const res = await feedApp().request("/api/v1/feed");
    assert.equal(res.status, 401);
  });

  it("derives conversation bursts with counts, snippet, channel, participants", async () => {
    const cookie = await makeUser("feed-test-admin", "admin");
    const db = await getDb();

    const alice = await createUser("feed-test-alice", "pass");
    const bob = await createUser("feed-test-bob", "pass");
    const ch = await createChannel("feed-test-room", alice.id);
    await addParticipant(ch.id, bob.id);

    // Burst 1: two messages 5 minutes apart, ~3h ago.
    await insertMsg(ch.id, "user", "feed-test-alice", "hello there", ago(185));
    await insertMsg(ch.id, "assistant", "feed-test-bob", "hi alice", ago(180));
    // Burst 2: two messages ~30m ago, well past the 45m gap from burst 1.
    await insertMsg(ch.id, "user", "feed-test-alice", "still around?", ago(31));
    await insertMsg(ch.id, "assistant", "feed-test-bob", "yes I am", ago(30));

    const res = await feedApp().request("/api/v1/feed", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { events: any[] };
    const chatEvents = body.events.filter((e) => e.kind === "chat" && e.conversationId === ch.id);
    assert.equal(chatEvents.length, 2, "gap > 45m splits into two bursts");
    for (const ev of chatEvents) {
      assert.equal(ev.messageCount, 2);
      assert.equal(ev.channelName, "feed-test-room");
      assert.equal(ev.participants.length, 2);
      assert.ok(ev.snippet.length >= 1 && ev.snippet.length <= 3);
    }
    // Newest burst first; its snippet carries the last message text.
    const newest = chatEvents[0];
    assert.ok(newest.snippet.some((m: any) => m.text.includes("yes I am")));
    assert.deepEqual(new Set(newest.activeSenders), new Set(["feed-test-alice", "feed-test-bob"]));

    await db.delete(messages).where(eq(messages.conversation_id, ch.id));
  });

  it("excludes private conversations", async () => {
    const cookie = await makeUser("feed-test-admin", "admin");
    const db = await getDb();
    const owner = await createUser("feed-test-owner", "pass");
    const ch = await createChannel("feed-test-secret", owner.id, { private: true });
    await insertMsg(ch.id, "user", "feed-test-owner", "top secret", ago(10));

    const res = await feedApp().request("/api/v1/feed", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    const body = (await res.json()) as { events: any[] };
    assert.ok(
      !body.events.some((e) => e.kind === "chat" && e.conversationId === ch.id),
      "private conversation must not appear in the feed",
    );

    await db.delete(messages).where(eq(messages.conversation_id, ch.id));
  });

  it("excludes sender-less announcement events from chat bursts (#687)", async () => {
    const cookie = await makeUser("feed-test-admin", "admin");
    const db = await getDb();
    const owner = await createUser("feed-test-owner", "pass");
    const ch = await createChannel("feed-test-commons", owner.id);
    // A run of pure #system announcements — events, not conversation. They must not form a
    // "chat burst" card (which would render the null sender as "mind" — the #687 confusion).
    await insertMsg(ch.id, "event", null, "atlas has joined", ago(12));
    await insertMsg(ch.id, "event", null, "willow has joined", ago(11));

    const res = await feedApp().request("/api/v1/feed", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    const body = (await res.json()) as { events: any[] };
    assert.ok(
      !body.events.some((e) => e.kind === "chat" && e.conversationId === ch.id),
      "an announcement-only channel must not produce a chat burst card",
    );

    await db.delete(messages).where(eq(messages.conversation_id, ch.id));
  });

  it("merges lifecycle events and redacts mind_error/backup_failed for non-privileged callers", async () => {
    const adminCookie = await makeUser("feed-test-admin", "admin");
    const userCookie = await makeUser("feed-test-user", "user");

    await publishActivity({ type: "mind_started", mind: "feed-test-m1", summary: "started up" });
    await publishActivity({
      type: "mind_error",
      mind: "feed-test-m1",
      summary: "SECRET stack trace detail",
    });
    await publishActivity({
      type: "backup_failed",
      mind: "feed-test-m1",
      summary: "Scheduled backup failed: SECRET restic repo /mnt/creds error",
    });

    const asUser = (await (
      await feedApp().request("/api/v1/feed", {
        headers: { Cookie: `volute_session=${userCookie}` },
      })
    ).json()) as { events: any[] };
    const userErr = asUser.events.find(
      (e) => e.kind === "lifecycle" && e.type === "mind_error" && e.mind === "feed-test-m1",
    );
    assert.ok(userErr, "error row present for non-privileged caller");
    assert.ok(
      !userErr.summary.includes("SECRET"),
      "raw error detail must be redacted for non-privileged callers",
    );
    const userBackup = asUser.events.find(
      (e) => e.kind === "lifecycle" && e.type === "backup_failed" && e.mind === "feed-test-m1",
    );
    assert.ok(userBackup, "backup_failed row present for non-privileged caller");
    assert.ok(
      !userBackup.summary.includes("SECRET"),
      "raw backup error detail must be redacted for non-privileged callers",
    );
    assert.ok(
      asUser.events.some((e) => e.kind === "lifecycle" && e.type === "mind_started"),
      "started event is included",
    );

    const asAdmin = (await (
      await feedApp().request("/api/v1/feed", {
        headers: { Cookie: `volute_session=${adminCookie}` },
      })
    ).json()) as { events: any[] };
    const adminErr = asAdmin.events.find(
      (e) => e.kind === "lifecycle" && e.type === "mind_error" && e.mind === "feed-test-m1",
    );
    assert.ok(adminErr, "error row present for admin");
    assert.equal(adminErr.summary, "SECRET stack trace detail");
    const adminBackup = asAdmin.events.find(
      (e) => e.kind === "lifecycle" && e.type === "backup_failed" && e.mind === "feed-test-m1",
    );
    assert.ok(adminBackup, "backup_failed row present for admin");
    assert.equal(
      adminBackup.summary,
      "Scheduled backup failed: SECRET restic repo /mnt/creds error",
    );
  });

  it("orders same-second bursts by last message id (newest id first)", async () => {
    const cookie = await makeUser("feed-test-admin", "admin");
    const db = await getDb();
    const convA = await createConversation({ participantIds: [] });
    const convB = await createConversation({ participantIds: [] });
    const stamp = ago(90);
    // Same endedAt second; convB's message is inserted second, so it gets the higher id.
    await insertMsg(convA.id, "user", "feed-test-a", "from A", stamp);
    await insertMsg(convB.id, "user", "feed-test-b", "from B", stamp);

    const res = await feedApp().request("/api/v1/feed", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    const body = (await res.json()) as { events: any[] };
    const order = body.events
      .filter(
        (e) =>
          e.kind === "chat" && (e.conversationId === convA.id || e.conversationId === convB.id),
      )
      .map((e) => e.conversationId);
    assert.deepEqual(order, [convB.id, convA.id], "higher last-message id sorts first on a tie");

    await db.delete(messages).where(eq(messages.conversation_id, convA.id));
    await db.delete(messages).where(eq(messages.conversation_id, convB.id));
    await db.delete(conversations).where(inArray(conversations.id, [convA.id, convB.id]));
  });

  it("builds a snippet from the last 3 messages, handling tool-only, unparseable, and long text", async () => {
    const cookie = await makeUser("feed-test-admin", "admin");
    const db = await getDb();
    const conv = await createConversation({ participantIds: [] });

    const longText = "x".repeat(400);
    // One tight burst of 5 messages (a few minutes apart, within the 45m gap).
    await insertMsg(conv.id, "user", "feed-test-a", "first", ago(50));
    await insertMsg(conv.id, "assistant", "feed-test-b", "second", ago(49));
    // Unparseable content → extractText returns it raw.
    await db.insert(messages).values({
      conversation_id: conv.id,
      role: "assistant",
      sender_name: "feed-test-b",
      content: "not json at all",
      created_at: ago(48),
    });
    // Tool-only content (no text block) → empty snippet text.
    await db.insert(messages).values({
      conversation_id: conv.id,
      role: "assistant",
      sender_name: "feed-test-b",
      content: JSON.stringify([{ type: "tool_use", name: "Bash", input: {} }]),
      created_at: ago(47),
    });
    await insertMsg(conv.id, "assistant", "feed-test-b", longText, ago(46));

    const res = await feedApp().request("/api/v1/feed", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    const body = (await res.json()) as { events: any[] };
    const ev = body.events.find((e) => e.kind === "chat" && e.conversationId === conv.id);
    assert.ok(ev);
    assert.equal(ev.messageCount, 5, "burst counts all 5 messages");
    assert.equal(ev.snippet.length, 3, "snippet keeps only the last 3");
    assert.equal(ev.snippet[0].text, "not json at all", "unparseable content passes through raw");
    assert.equal(ev.snippet[1].text, "", "tool-only message yields empty text");
    assert.equal(ev.snippet[2].text.length, 281, "long text truncated to 280 chars + ellipsis");
    assert.ok(ev.snippet[2].text.endsWith("…"));

    await db.delete(messages).where(eq(messages.conversation_id, conv.id));
    await db.delete(conversations).where(eq(conversations.id, conv.id));
  });
});

describe("daily digest", () => {
  const todayKey = getPeriodKey(new Date(), "day");

  async function cleanDigest() {
    const db = await getDb();
    await db
      .delete(summaries)
      .where(and(eq(summaries.mind, "system"), eq(summaries.period, "day")));
    await db.delete(summaries).where(sql`mind = '_system' AND content LIKE 'feed-test-%'`);
  }

  beforeEach(cleanDigest);
  afterEach(cleanDigest);

  it("returns a cached row verbatim without calling the AI", async () => {
    const db = await getDb();
    await db.insert(summaries).values({
      mind: "system",
      period: "day",
      period_key: todayKey,
      content: "cached digest text",
    });
    let called = false;
    const result = await getDailyDigest(async () => {
      called = true;
      return "fresh";
    });
    assert.equal(result.content, "cached digest text");
    assert.equal(called, false, "AI must not run when a cache row exists");
  });

  it("caches an AI-generated digest", async () => {
    const db = await getDb();
    await db.insert(summaries).values({
      mind: "_system",
      period: "hour",
      period_key: `${todayKey}T10`,
      content: "feed-test-source hour summary",
    });

    const result = await getDailyDigest(async () => "an AI digest");
    assert.equal(result.content, "an AI digest");

    const cached = await db
      .select({ content: summaries.content })
      .from(summaries)
      .where(and(eq(summaries.mind, "system"), eq(summaries.period, "day")))
      .get();
    assert.equal(cached?.content, "an AI digest", "AI digest must be cached");
  });

  it("falls back to a deterministic one-liner without caching on AI failure", async () => {
    const db = await getDb();
    await db.insert(summaries).values({
      mind: "_system",
      period: "hour",
      period_key: `${todayKey}T11`,
      content: "feed-test-source hour summary",
    });

    const result = await getDailyDigest(async () => null);
    assert.match(result.content, /active across .* today\./);

    const cached = await db
      .select({ content: summaries.content })
      .from(summaries)
      .where(and(eq(summaries.mind, "system"), eq(summaries.period, "day")))
      .get();
    assert.equal(cached, undefined, "deterministic fallback must not be cached");
  });

  it("falls back to recent turn summaries as material when no hour summaries exist", async () => {
    const db = await getDb();
    await db.delete(summaries).where(inArray(summaries.period, ["turn", "hour"]));
    await db.insert(summaries).values([
      {
        mind: "feed-test-x",
        period: "turn",
        period_key: "feed-test-turn-1",
        content: "z".repeat(400),
      },
      {
        mind: "feed-test-y",
        period: "turn",
        period_key: "feed-test-turn-2",
        content: "did a thing",
      },
    ]);

    let captured = "";
    const result = await getDailyDigest(async (_system, material) => {
      captured = material;
      return "the digest";
    });
    assert.equal(result.content, "the digest");
    assert.ok(captured.includes("[feed-test-x]"), "material carries the per-mind prefix");
    assert.ok(captured.includes("…"), "an overlong turn summary is truncated to ~300 chars");

    await db.delete(summaries).where(inArray(summaries.period, ["turn", "hour"]));
  });

  it("returns empty content and skips the AI when there is no source material", async () => {
    const db = await getDb();
    await db.delete(summaries).where(inArray(summaries.period, ["turn", "hour"]));
    let called = false;
    const result = await getDailyDigest(async () => {
      called = true;
      return "unused";
    });
    assert.equal(result.content, "");
    assert.equal(called, false, "AI must not run without material");
    const cached = await db
      .select()
      .from(summaries)
      .where(and(eq(summaries.mind, "system"), eq(summaries.period, "day")))
      .get();
    assert.equal(cached, undefined, "empty digest is not cached");
  });

  it("uses singular grammar for exactly one active mind and one conversation", async () => {
    const db = await getDb();
    await db.delete(messages);
    await db.delete(summaries).where(inArray(summaries.period, ["turn", "hour"]));
    await db.insert(summaries).values({
      mind: "feed-test-solo",
      period: "turn",
      period_key: "feed-test-solo-turn",
      content: "a lone thought",
    });
    const conv = await createConversation({ participantIds: [] });
    await insertMsg(conv.id, "user", "feed-test-solo", "hi", ago(5));

    const result = await getDailyDigest(async () => null);
    assert.equal(result.content, "1 mind was active across 1 conversation today.");

    await db.delete(messages).where(eq(messages.conversation_id, conv.id));
    await db.delete(conversations).where(eq(conversations.id, conv.id));
    await db.delete(summaries).where(inArray(summaries.period, ["turn", "hour"]));
  });
});

describe("v1 conversations read loosening", () => {
  async function cleanup2() {
    const db = await getDb();
    // conversations.user_id references users with no cascade, so drop the
    // caller-owned conversations (cascading their messages/participants) first.
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`username LIKE 'conv-test-%'`);
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      await db.delete(conversations).where(inArray(conversations.user_id, ids));
    }
    await db.delete(users).where(sql`username LIKE 'conv-test-%'`);
  }
  beforeEach(cleanup2);
  afterEach(cleanup2);

  it("a non-participant may read a non-private conversation", async () => {
    const owner = await createUser("conv-test-owner", "pass");
    const viewer = await createUser("conv-test-viewer", "pass");
    await setUserRole(viewer.id, "user");
    const cookie = await createSession(viewer.id);
    const conv = await createConversation({ userId: owner.id, participantIds: [owner.id] });
    await insertMsg(conv.id, "user", "conv-test-owner", "public words", ago(5));

    const res = await convApp().request(`/api/v1/conversations/${conv.id}/messages`, {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items: any[] };
    assert.ok(body.items.length >= 1);
  });

  it("a non-participant is 404'd on a private conversation", async () => {
    const owner = await createUser("conv-test-owner", "pass");
    const viewer = await createUser("conv-test-viewer", "pass");
    await setUserRole(viewer.id, "user");
    const cookie = await createSession(viewer.id);
    const conv = await createConversation({ userId: owner.id, participantIds: [owner.id] });
    await setConversationPrivate(conv.id, true);
    await insertMsg(conv.id, "user", "conv-test-owner", "hidden words", ago(5));

    const res = await convApp().request(`/api/v1/conversations/${conv.id}/messages`, {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 404);
  });

  it("a participant may read a private conversation", async () => {
    const owner = await createUser("conv-test-owner", "pass");
    const member = await createUser("conv-test-member", "pass");
    await setUserRole(member.id, "user");
    const cookie = await createSession(member.id);
    const conv = await createConversation({
      userId: owner.id,
      participantIds: [owner.id, member.id],
    });
    await setConversationPrivate(conv.id, true);
    await insertMsg(conv.id, "user", "conv-test-owner", "members only", ago(5));

    const res = await convApp().request(`/api/v1/conversations/${conv.id}/messages`, {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items: any[] };
    assert.ok(body.items.length >= 1);
  });
});
