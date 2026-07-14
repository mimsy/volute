import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq, sql } from "drizzle-orm";
import { createUser, getOrCreateMindUser } from "../packages/daemon/src/lib/auth.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { publish as publishMindEvent } from "../packages/daemon/src/lib/events/mind-events.js";
import {
  activity,
  mindHistory,
  summaries,
  turns,
  users,
} from "../packages/daemon/src/lib/schema.js";
import { createSession, deleteSession } from "../packages/daemon/src/web/middleware/auth.js";

const TEST_USERNAME = "history-test-admin";
let sessionId: string;

async function cleanup() {
  const db = await getDb();
  await db.delete(users).where(eq(users.username, TEST_USERNAME));
  await db.delete(users).where(sql`username LIKE 'test-history-%'`);
  // Clean up test turns, history, summaries, and activity
  await db.delete(summaries).where(sql`mind LIKE 'test-history-%'`);
  await db.delete(turns).where(sql`mind LIKE 'test-history-%'`);
  await db.delete(mindHistory).where(sql`mind LIKE 'test-history-%'`);
  await db.delete(activity).where(sql`mind LIKE 'test-history-%'`);
}

/** Create a non-admin mind user (role "user") and return a session cookie for it. */
async function mindSession(mindName: string): Promise<string> {
  const user = await getOrCreateMindUser(mindName);
  return createSession(user.id);
}

async function setupAuth(): Promise<string> {
  const user = await createUser(TEST_USERNAME, "pass");
  sessionId = await createSession(user.id);
  return sessionId;
}

describe("web history routes", () => {
  beforeEach(cleanup);
  afterEach(async () => {
    if (sessionId) deleteSession(sessionId);
    await cleanup();
  });

  it("GET /api/v1/history/turns — returns empty array when no turns", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request("/api/v1/history/turns", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
  });

  it("GET /api/v1/history/turns — returns turns with mind field", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const db = await getDb();

    const turnId = randomUUID();
    await db.insert(turns).values({
      id: turnId,
      mind: "test-history-mind1",
      status: "complete",
    });

    const res = await app.request("/api/v1/history/turns", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{ id: string; mind: string }>;
    assert.ok(body.length >= 1);
    const found = body.find((t) => t.id === turnId);
    assert.ok(found, "Turn should be in response");
    assert.equal(found.mind, "test-history-mind1");
  });

  it("GET /api/v1/history/turns?mind=name — filters by mind", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const db = await getDb();

    const turnId1 = randomUUID();
    const turnId2 = randomUUID();
    await db.insert(turns).values([
      { id: turnId1, mind: "test-history-mind1", status: "complete" },
      { id: turnId2, mind: "test-history-mind2", status: "complete" },
    ]);

    const res = await app.request("/api/v1/history/turns?mind=test-history-mind1", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{ id: string; mind: string }>;
    assert.ok(body.every((t) => t.mind === "test-history-mind1"));
    assert.ok(body.some((t) => t.id === turnId1));
    assert.ok(!body.some((t) => t.id === turnId2));
  });

  it("GET /api/v1/history/turns — returns turns from multiple minds", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const db = await getDb();

    const turnId1 = randomUUID();
    const turnId2 = randomUUID();
    await db.insert(turns).values([
      { id: turnId1, mind: "test-history-mind1", status: "complete" },
      { id: turnId2, mind: "test-history-mind2", status: "complete" },
    ]);

    const res = await app.request("/api/v1/history/turns", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{ id: string; mind: string }>;
    const minds = new Set(body.map((t) => t.mind));
    assert.ok(minds.has("test-history-mind1"));
    assert.ok(minds.has("test-history-mind2"));
  });

  it("GET /api/v1/history/turns — includes summary when present", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const db = await getDb();

    const turnId = randomUUID();
    await db.insert(turns).values({
      id: turnId,
      mind: "test-history-mind1",
      status: "complete",
    });
    await db.insert(summaries).values({
      mind: "test-history-mind1",
      period: "turn",
      period_key: turnId,
      content: "Test summary content",
    });

    const res = await app.request(`/api/v1/history/turns?turnId=${turnId}`, {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{ id: string; summary: string | null }>;
    assert.equal(body.length, 1);
    assert.equal(body[0].summary, "Test summary content");
  });

  it("GET /api/v1/history/turns — orders same-second messages by id (#403)", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const db = await getDb();

    const turnId = randomUUID();
    await db.insert(turns).values({
      id: turnId,
      mind: "test-history-mind1",
      status: "complete",
    });
    // Question and answer share the exact same created_at second. The inbound is recorded
    // first (lower id); without the id tiebreaker the pair could flip and read as an
    // answer-before-question exchange.
    const ts = "2020-06-01 12:00:00";
    await db.insert(mindHistory).values({
      mind: "test-history-mind1",
      type: "inbound",
      channel: "@alice",
      sender: "alice",
      content: "question?",
      turn_id: turnId,
      created_at: ts,
    });
    await db.insert(mindHistory).values({
      mind: "test-history-mind1",
      type: "outbound",
      channel: "@alice",
      content: "answer.",
      turn_id: turnId,
      created_at: ts,
    });

    const res = await app.request(`/api/v1/history/turns?turnId=${turnId}`, {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{
      conversations: Array<{ messages: Array<{ role: string }> }>;
    }>;
    assert.equal(body.length, 1);
    const messages = body[0].conversations[0].messages;
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, "user", "the question (lower id) must come first");
    assert.equal(messages[1].role, "assistant", "the answer (higher id) must come second");
  });

  it("GET /api/v1/history/turns — a system event is an event, never a conversation", async () => {
    // The timeline renders `conversations` as chat. A system event has no sender and no
    // channel to reply to, so it must never appear there — it belongs in `events`, which
    // the UI renders as a system marker. Letting it into `conversations` is what made
    // events show up as blue message bubbles from a phantom sender named "user".
    const cookie = await setupAuth();
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const db = await getDb();

    const turnId = randomUUID();
    await db.insert(turns).values({ id: turnId, mind: "test-history-mind1", status: "complete" });
    const [eventRow] = await db
      .insert(mindHistory)
      .values({
        mind: "test-history-mind1",
        type: "event",
        channel: "event:orientation:1",
        sender: null,
        content: "You've just been created as a seed.",
        metadata: JSON.stringify({ systemEventId: 1, label: "Orientation" }),
        turn_id: turnId,
      })
      .returning({ id: mindHistory.id });
    // The turn was triggered by the event (as linkPendingInbound would set).
    await db.update(turns).set({ trigger_event_id: eventRow.id }).where(eq(turns.id, turnId));

    const res = await app.request(`/api/v1/history/turns?turnId=${turnId}`, {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{
      conversations: unknown[];
      events: Array<{ id: number; label: string; content: string }>;
      trigger: { event?: { type: string; label: string } } | null;
    }>;
    assert.equal(body.length, 1);

    assert.deepEqual(body[0].conversations, [], "an event must not become a conversation");

    assert.equal(body[0].events.length, 1);
    assert.equal(body[0].events[0].label, "Orientation");
    assert.equal(body[0].events[0].content, "You've just been created as a seed.");

    // The turn is flagged event-triggered, so the timeline can label the mind's closing
    // text a private reflection rather than rendering it as a reply.
    assert.equal(body[0].trigger?.event?.type, "orientation");
    assert.equal(body[0].trigger?.event?.label, "Orientation");
  });

  it("GET /api/v1/history/turns — a message turn carries no event flag", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const db = await getDb();

    const turnId = randomUUID();
    await db.insert(turns).values({ id: turnId, mind: "test-history-mind1", status: "complete" });
    const [inbound] = await db
      .insert(mindHistory)
      .values({
        mind: "test-history-mind1",
        type: "inbound",
        channel: "@alice",
        sender: "alice",
        content: "hello",
        turn_id: turnId,
      })
      .returning({ id: mindHistory.id });
    await db.update(turns).set({ trigger_event_id: inbound.id }).where(eq(turns.id, turnId));

    const res = await app.request(`/api/v1/history/turns?turnId=${turnId}`, {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    const body = (await res.json()) as Array<{
      conversations: unknown[];
      events: unknown[];
      trigger: { event?: unknown; sender: string | null } | null;
    }>;
    // A real message still routes to conversations, with its sender, and no event flag.
    assert.equal(body[0].conversations.length, 1);
    assert.deepEqual(body[0].events, []);
    assert.equal(body[0].trigger?.sender, "alice");
    assert.equal(body[0].trigger?.event, undefined);
  });

  it("GET /api/v1/history/turns — requires auth", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request("/api/v1/history/turns");
    assert.equal(res.status, 401);
  });

  it("GET /api/minds/:name/history — annotates senders with display names", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const db = await getDb();

    // A sender that has a display name distinct from its username.
    const sender = await createUser("test-history-alice", "pass");
    await db.update(users).set({ display_name: "Alice Example" }).where(eq(users.id, sender.id));

    await db.insert(mindHistory).values({
      mind: "test-history-mind1",
      type: "inbound",
      channel: "@test-history-alice",
      sender: "test-history-alice",
      content: "hello",
    });
    // A sender with no matching user record resolves to null.
    await db.insert(mindHistory).values({
      mind: "test-history-mind1",
      type: "inbound",
      channel: "#room",
      sender: "test-history-ghost",
      content: "boo",
    });

    const res = await app.request("/api/minds/test-history-mind1/history?full=true", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const rows = (await res.json()) as Array<{
      sender: string | null;
      sender_display_name: string | null;
    }>;
    const alice = rows.find((r) => r.sender === "test-history-alice");
    const ghost = rows.find((r) => r.sender === "test-history-ghost");
    assert.equal(alice?.sender_display_name, "Alice Example");
    assert.equal(ghost?.sender_display_name, null);
  });

  // ── Summaries endpoint tests ──

  it("GET /api/v1/history/summaries — requires period param", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request("/api/v1/history/summaries", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok((body as { error: string }).error.includes("period"));
  });

  it("GET /api/v1/history/summaries — rejects invalid period", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request("/api/v1/history/summaries?period=invalid", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 400);
  });

  it("GET /api/v1/history/summaries — returns summaries by period", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const db = await getDb();

    await db.insert(summaries).values({
      mind: "test-history-sum1",
      period: "hour",
      period_key: "2026-03-22T14",
      content: "Hourly summary content",
      metadata: JSON.stringify({ deterministic: true }),
    });

    const res = await app.request("/api/v1/history/summaries?period=hour&mind=test-history-sum1", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{ content: string; period_key: string }>;
    assert.ok(body.length >= 1);
    assert.equal(body[0].content, "Hourly summary content");
    assert.equal(body[0].period_key, "2026-03-22T14");
  });

  it("GET /api/v1/history/summaries — fetches by IDs", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const db = await getDb();

    const result = await db
      .insert(summaries)
      .values({
        mind: "test-history-sum2",
        period: "turn",
        period_key: "some-turn-id",
        content: "ID-based fetch test",
      })
      .returning({ id: summaries.id });
    const id = result[0].id;

    const res = await app.request(`/api/v1/history/summaries?ids=${id}`, {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{ id: number; content: string }>;
    assert.equal(body.length, 1);
    assert.equal(body[0].id, id);
    assert.equal(body[0].content, "ID-based fetch test");
  });

  it("GET /api/v1/history/summaries — respects from/to range", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const db = await getDb();

    await db.insert(summaries).values([
      {
        mind: "test-history-range",
        period: "hour",
        period_key: "2026-03-20T10",
        content: "Early",
      },
      {
        mind: "test-history-range",
        period: "hour",
        period_key: "2026-03-22T14",
        content: "Later",
      },
    ]);

    const res = await app.request(
      "/api/v1/history/summaries?period=hour&mind=test-history-range&from=2026-03-21&to=2026-03-23",
      { headers: { Cookie: `volute_session=${cookie}` } },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{ period_key: string }>;
    assert.equal(body.length, 1);
    assert.equal(body[0].period_key, "2026-03-22T14");
  });

  it("GET /api/v1/history/summaries — week tier: date bounds match ISO week keys", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const db = await getDb();

    // Current-year week keys. Under binary collation "W" sorts above digits, so
    // a raw date bound like "2026-06-29" would wrongly exclude "2026-W14".
    await db.insert(summaries).values([
      { mind: "test-history-weeks", period: "week", period_key: "2026-W12", content: "W12" },
      { mind: "test-history-weeks", period: "week", period_key: "2026-W14", content: "W14" },
      { mind: "test-history-weeks", period: "week", period_key: "2026-W27", content: "W27" },
    ]);

    // Top-level week fetch used to pass `to=<date>` only. 2026-06-29 is in W27,
    // so weeks up to and including W27 should return.
    const res = await app.request(
      "/api/v1/history/summaries?period=week&mind=test-history-weeks&to=2026-06-29",
      { headers: { Cookie: `volute_session=${cookie}` } },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{ period_key: string }>;
    const keys = body.map((r) => r.period_key).sort();
    assert.deepEqual(keys, ["2026-W12", "2026-W14", "2026-W27"]);
  });

  it("GET /api/v1/history/summaries — week tier: month-shaped range returns overlapping weeks", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const db = await getDb();

    // March 2026: W09 (starts Feb 23, overlaps Mar 1) .. W14 (ends Apr 5).
    await db.insert(summaries).values([
      { mind: "test-history-weeks", period: "week", period_key: "2026-W08", content: "W08" },
      { mind: "test-history-weeks", period: "week", period_key: "2026-W10", content: "W10" },
      { mind: "test-history-weeks", period: "week", period_key: "2026-W13", content: "W13" },
      { mind: "test-history-weeks", period: "week", period_key: "2026-W20", content: "W20" },
    ]);

    // Month drill-down passes from=YYYY-MM-01, to=<last day of month>.
    const res = await app.request(
      "/api/v1/history/summaries?period=week&mind=test-history-weeks&from=2026-03-01&to=2026-03-31",
      { headers: { Cookie: `volute_session=${cookie}` } },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{ period_key: string }>;
    const keys = body.map((r) => r.period_key).sort();
    // W08 (all February) and W20 (May) excluded; the March-overlapping weeks returned.
    assert.deepEqual(keys, ["2026-W10", "2026-W13"]);
  });

  it("GET /api/v1/history/summaries — month tier pages backward with an inclusive `to` cursor", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const db = await getDb();

    await db.insert(summaries).values([
      { mind: "test-history-page", period: "month", period_key: "2026-01", content: "Jan" },
      { mind: "test-history-page", period: "month", period_key: "2026-02", content: "Feb" },
      { mind: "test-history-page", period: "month", period_key: "2026-03", content: "Mar" },
      { mind: "test-history-page", period: "month", period_key: "2026-04", content: "Apr" },
    ]);

    const fetchPage = async (to?: string) => {
      const qs = new URLSearchParams({ period: "month", mind: "test-history-page", limit: "2" });
      if (to) qs.set("to", to);
      const res = await app.request(`/api/v1/history/summaries?${qs}`, {
        headers: { Cookie: `volute_session=${cookie}` },
      });
      assert.equal(res.status, 200);
      return (await res.json()) as Array<{ period_key: string }>;
    };

    // Page 1: newest two, returned descending.
    const p1 = await fetchPage();
    assert.deepEqual(
      p1.map((r) => r.period_key),
      ["2026-04", "2026-03"],
    );

    // Page 2: cursor = oldest loaded key (inclusive), so it re-returns "2026-03"
    // (client dedups it) plus the next older month.
    const p2 = await fetchPage("2026-03");
    assert.deepEqual(
      p2.map((r) => r.period_key),
      ["2026-03", "2026-02"],
    );

    // Page 3: cursor = "2026-01" → only the terminal row, nothing older.
    const p3 = await fetchPage("2026-01");
    assert.deepEqual(
      p3.map((r) => r.period_key),
      ["2026-01"],
    );
  });

  it("GET /api/v1/history/summaries — caps limit at 200", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request(
      "/api/v1/history/summaries?period=hour&mind=test-history-cap&limit=999",
      { headers: { Cookie: `volute_session=${cookie}` } },
    );
    assert.equal(res.status, 200);
    // We can't directly check the SQL limit, but we verify the endpoint doesn't error
    const body = await res.json();
    assert.ok(Array.isArray(body));
  });

  // ── Cross-mind isolation (non-admin callers) ──
  //
  // Minds are untrusted principals. A mind authenticates as a non-admin "user"
  // whose username is its own name; the history routes must force scoping to the
  // caller's own mind and ignore any `?mind=` / `?ids=` pointing at another mind.

  it("GET /turns?mind=<other> — a mind cannot read another mind's turns", async () => {
    const cookie = await mindSession("test-history-alice");
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const db = await getDb();

    const aliceTurn = randomUUID();
    const bobTurn = randomUUID();
    await db.insert(turns).values([
      { id: aliceTurn, mind: "test-history-alice", status: "complete" },
      { id: bobTurn, mind: "test-history-bob", status: "complete" },
    ]);

    // Alice tries to read bob's turns; the ?mind= param must be ignored.
    const res = await app.request("/api/v1/history/turns?mind=test-history-bob", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{ id: string; mind: string }>;
    assert.ok(
      body.every((t) => t.mind === "test-history-alice"),
      "only the caller's own turns are returned",
    );
    assert.ok(!body.some((t) => t.id === bobTurn), "another mind's turn must not leak");
  });

  it("GET /activity?mind=<other> — a mind cannot read another mind's activity", async () => {
    const cookie = await mindSession("test-history-alice");
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const db = await getDb();

    await db.insert(activity).values([
      { type: "note_created", mind: "test-history-alice", summary: "alice note" },
      { type: "note_created", mind: "test-history-bob", summary: "bob note" },
    ]);

    const res = await app.request("/api/v1/history/activity?mind=test-history-bob", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{ mind: string; summary: string }>;
    assert.ok(
      body.every((a) => a.mind === "test-history-alice"),
      "only the caller's own activity is returned",
    );
    assert.ok(!body.some((a) => a.summary === "bob note"), "another mind's activity must not leak");
  });

  it("GET /summaries?mind=<other> — a mind cannot read another mind's summaries", async () => {
    const cookie = await mindSession("test-history-alice");
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const db = await getDb();

    await db.insert(summaries).values([
      {
        mind: "test-history-alice",
        period: "hour",
        period_key: "2026-03-22T14",
        content: "alice hourly",
      },
      {
        mind: "test-history-bob",
        period: "hour",
        period_key: "2026-03-22T14",
        content: "bob hourly",
      },
    ]);

    const res = await app.request("/api/v1/history/summaries?period=hour&mind=test-history-bob", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{ mind: string; content: string }>;
    assert.ok(
      body.every((s) => s.mind === "test-history-alice"),
      "only the caller's own summaries are returned",
    );
    assert.ok(
      !body.some((s) => s.content === "bob hourly"),
      "another mind's summary must not leak",
    );
  });

  it("GET /summaries?ids=<other's ids> — a mind cannot fetch another mind's summaries by id", async () => {
    const cookie = await mindSession("test-history-alice");
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const db = await getDb();

    const inserted = await db
      .insert(summaries)
      .values([
        {
          mind: "test-history-alice",
          period: "turn",
          period_key: "alice-turn",
          content: "alice by id",
        },
        {
          mind: "test-history-bob",
          period: "turn",
          period_key: "bob-turn",
          content: "bob by id",
        },
      ])
      .returning({ id: summaries.id, mind: summaries.mind });
    const aliceId = inserted.find((r) => r.mind === "test-history-alice")!.id;
    const bobId = inserted.find((r) => r.mind === "test-history-bob")!.id;

    // Requesting both ids returns only alice's row; bob's id is filtered out.
    const res = await app.request(`/api/v1/history/summaries?ids=${aliceId},${bobId}`, {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{ id: number; mind: string }>;
    assert.ok(
      body.every((s) => s.mind === "test-history-alice"),
      "only the caller's own summary is returned",
    );
    assert.ok(!body.some((s) => s.id === bobId), "another mind's summary id must not leak");
  });

  it("GET /events — SSE only streams the caller's own mind events", async () => {
    const cookie = await mindSession("test-history-alice");
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request("/api/v1/history/events?mind=test-history-bob", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // The subscription registers synchronously in the stream's start(); publish
    // bob's event first (must be filtered), then alice's (must arrive).
    publishMindEvent("test-history-bob", {
      mind: "test-history-bob",
      type: "activity",
      summary: "bob-secret",
    } as Parameters<typeof publishMindEvent>[1]);
    publishMindEvent("test-history-alice", {
      mind: "test-history-alice",
      type: "activity",
      summary: "alice-visible",
    } as Parameters<typeof publishMindEvent>[1]);

    let received = "";
    // Read a couple of chunks; the first data frame should be alice's event.
    for (let i = 0; i < 3; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
      if (received.includes("data:")) break;
    }
    await reader.cancel();

    assert.ok(received.includes("alice-visible"), "caller's own event is streamed");
    assert.ok(!received.includes("bob-secret"), "another mind's event must not be streamed");
  });
});
