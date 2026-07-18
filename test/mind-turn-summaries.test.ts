import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import { createUser, getOrCreateMindUser } from "../packages/daemon/src/lib/auth.js";
import {
  MIND_TURN_SUMMARY_MAX_CHARS,
  summarizeTurn,
  supersedeTurnSummary,
} from "../packages/daemon/src/lib/daemon/summarizer.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { mindHistory, summaries, turns, users } from "../packages/daemon/src/lib/schema.js";
import { createSession, deleteSession } from "../packages/daemon/src/web/middleware/auth.js";

const sessions: string[] = [];

async function cleanup() {
  const db = await getDb();
  // turns.summary_id references summaries.id — clear turns before the rows they point at.
  await db.delete(turns).where(sql`mind LIKE 'test-turnsum-%'`);
  await db.delete(summaries).where(sql`mind LIKE 'test-turnsum-%'`);
  await db.delete(mindHistory).where(sql`mind LIKE 'test-turnsum-%'`);
  await db.delete(users).where(sql`username LIKE 'test-turnsum-%'`);
}

/** Cookie for a non-admin mind user (role "user", username = mind name). */
async function mindCookie(mindName: string): Promise<string> {
  const user = await getOrCreateMindUser(mindName);
  const sid = await createSession(user.id);
  sessions.push(sid);
  return sid;
}

/** Cookie for an admin user. */
async function adminCookie(username: string): Promise<string> {
  const user = await createUser(username, "pass");
  const sid = await createSession(user.id);
  sessions.push(sid);
  return sid;
}

async function summaryRow(mind: string, turnId: string) {
  const db = await getDb();
  return db
    .select()
    .from(summaries)
    .where(
      and(eq(summaries.mind, mind), eq(summaries.period, "turn"), eq(summaries.period_key, turnId)),
    )
    .get();
}

describe("mind-authored turn summaries", () => {
  beforeEach(cleanup);
  afterEach(async () => {
    while (sessions.length) deleteSession(sessions.pop()!);
    await cleanup();
  });

  // ── supersedeTurnSummary (helper) ──

  it("supersedes an existing provisional row in place, preserving it in metadata", async () => {
    const db = await getDb();
    const mind = "test-turnsum-mind1";
    const turnId = randomUUID();
    await db.insert(turns).values({ id: turnId, mind, thread: "s1", status: "complete" });
    const inserted = await db
      .insert(summaries)
      .values({
        mind,
        period: "turn",
        period_key: turnId,
        content: "I did something (auto).",
        metadata: JSON.stringify({ deterministic: true, tool_count: 2 }),
      })
      .returning({ id: summaries.id });
    await db.update(turns).set({ summary_id: inserted[0].id }).where(eq(turns.id, turnId));

    const result = await supersedeTurnSummary(mind, turnId, "  Here is my own account.  ");
    assert.deepEqual(result, { status: "ok", created: false });

    const row = await summaryRow(mind, turnId);
    assert.equal(row?.content, "Here is my own account.");
    const meta = JSON.parse(row?.metadata ?? "{}");
    assert.equal(meta.author, "mind");
    assert.equal(typeof meta.authored_at, "string");
    assert.equal(meta.superseded.content, "I did something (auto).");
    assert.equal(meta.superseded.deterministic, true);
    // Prior metadata keys survive.
    assert.equal(meta.tool_count, 2);
  });

  it("keeps the ORIGINAL provisional through repeated mind edits", async () => {
    const db = await getDb();
    const mind = "test-turnsum-mind1";
    const turnId = randomUUID();
    await db.insert(turns).values({ id: turnId, mind, status: "complete" });
    await db.insert(summaries).values({
      mind,
      period: "turn",
      period_key: turnId,
      content: "auto text",
      metadata: JSON.stringify({ deterministic: false }),
    });

    await supersedeTurnSummary(mind, turnId, "first edit");
    await supersedeTurnSummary(mind, turnId, "second edit");

    const row = await summaryRow(mind, turnId);
    assert.equal(row?.content, "second edit");
    const meta = JSON.parse(row?.metadata ?? "{}");
    assert.equal(meta.superseded.content, "auto text", "the original provisional is preserved");
  });

  it("inserts a row and links turns.summary_id when no summary exists yet", async () => {
    const db = await getDb();
    const mind = "test-turnsum-mind2";
    const turnId = randomUUID();
    await db.insert(turns).values({ id: turnId, mind, thread: "s1", status: "complete" });

    const result = await supersedeTurnSummary(mind, turnId, "My account, written first.");
    assert.deepEqual(result, { status: "ok", created: true });

    const row = await summaryRow(mind, turnId);
    assert.ok(row, "summary row inserted");
    assert.equal(row?.content, "My account, written first.");
    const meta = JSON.parse(row?.metadata ?? "{}");
    assert.equal(meta.author, "mind");
    assert.equal(meta.superseded, undefined, "no prior row → no superseded field");

    const turn = await db.select().from(turns).where(eq(turns.id, turnId)).get();
    assert.equal(turn?.summary_id, row?.id, "turns.summary_id linked");
  });

  it("the summarizer's dedup guard respects a mind-authored row written first", async () => {
    const db = await getDb();
    const mind = "test-turnsum-mind3";
    const turnId = randomUUID();
    await db.insert(turns).values({ id: turnId, mind, thread: "s1", status: "complete" });
    // Events the summarizer would gather for this turn.
    await db.insert(mindHistory).values([
      { mind, type: "inbound", channel: "@x", sender: "x", content: "hi", turn_id: turnId },
      { mind, type: "text", content: "hello back", turn_id: turnId },
    ]);

    await supersedeTurnSummary(mind, turnId, "Mine, and it should stick.");

    // Now the automatic summarizer runs for the same turn; summaryExists must short-circuit it.
    await summarizeTurn(mind, "s1", undefined, 0, turnId);

    const row = await summaryRow(mind, turnId);
    assert.equal(row?.content, "Mine, and it should stick.");
    assert.equal(JSON.parse(row?.metadata ?? "{}").author, "mind");
  });

  it("rejects unknown turn, wrong owner, empty and over-length content", async () => {
    const db = await getDb();
    const mind = "test-turnsum-owner";
    const other = "test-turnsum-other";
    const turnId = randomUUID();
    await db.insert(turns).values({ id: turnId, mind: other, status: "complete" });

    assert.deepEqual(await supersedeTurnSummary(mind, randomUUID(), "x"), { status: "not_found" });
    assert.deepEqual(await supersedeTurnSummary(mind, turnId, "x"), { status: "forbidden" });

    const own = randomUUID();
    await db.insert(turns).values({ id: own, mind, status: "complete" });
    assert.equal((await supersedeTurnSummary(mind, own, "   ")).status, "invalid");
    assert.equal(
      (await supersedeTurnSummary(mind, own, "a".repeat(MIND_TURN_SUMMARY_MAX_CHARS + 1))).status,
      "invalid",
    );
  });

  // ── API: PUT /api/minds/:name/turn-summaries ──

  it("PUT supersedes via the API and returns counts", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const db = await getDb();
    const mind = "test-turnsum-api1";
    const cookie = await mindCookie(mind);
    const turnId = randomUUID();
    await db.insert(turns).values({ id: turnId, mind, status: "complete" });

    const res = await app.request(`/api/minds/${mind}/turn-summaries`, {
      method: "PUT",
      headers: { Cookie: `volute_session=${cookie}`, "Content-Type": "application/json" },
      body: JSON.stringify({ summaries: [{ turnId, content: "My words." }] }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, updated: 0, created: 1 });

    const row = await summaryRow(mind, turnId);
    assert.equal(row?.content, "My words.");
  });

  it("PUT rejects a turn owned by another mind with 403", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const db = await getDb();
    const mind = "test-turnsum-alice";
    const cookie = await mindCookie(mind);
    const bobTurn = randomUUID();
    await db.insert(turns).values({ id: bobTurn, mind: "test-turnsum-bob", status: "complete" });

    const res = await app.request(`/api/minds/${mind}/turn-summaries`, {
      method: "PUT",
      headers: { Cookie: `volute_session=${cookie}`, "Content-Type": "application/json" },
      body: JSON.stringify({ summaries: [{ turnId: bobTurn, content: "sneaky" }] }),
    });
    assert.equal(res.status, 403);
  });

  it("PUT rejects a non-self mind token (another mind's route) with 403", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const cookie = await mindCookie("test-turnsum-alice");
    const res = await app.request("/api/minds/test-turnsum-bob/turn-summaries", {
      method: "PUT",
      headers: { Cookie: `volute_session=${cookie}`, "Content-Type": "application/json" },
      body: JSON.stringify({ summaries: [{ turnId: randomUUID(), content: "x" }] }),
    });
    assert.equal(res.status, 403);
  });

  it("PUT validates payload shape and content", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const db = await getDb();
    const mind = "test-turnsum-val";
    const cookie = await mindCookie(mind);
    const turnId = randomUUID();
    await db.insert(turns).values({ id: turnId, mind, status: "complete" });

    const put = (body: unknown) =>
      app.request(`/api/minds/${mind}/turn-summaries`, {
        method: "PUT",
        headers: { Cookie: `volute_session=${cookie}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    assert.equal((await put({ summaries: [] })).status, 400);
    assert.equal((await put({ summaries: [{ content: "no turn" }] })).status, 400);
    assert.equal((await put({ summaries: [{ turnId, content: "  " }] })).status, 400);
    assert.equal((await put({ summaries: [{ turnId, content: "a".repeat(4001) }] })).status, 400);
    assert.equal((await put({ summaries: [{ turnId: randomUUID(), content: "x" }] })).status, 404);
  });

  it("PUT requires auth", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request("/api/minds/test-turnsum-any/turn-summaries", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summaries: [{ turnId: randomUUID(), content: "x" }] }),
    });
    assert.equal(res.status, 401);
  });

  // ── GET /api/minds/:name/history?provisional=true (summary preset) ──

  it("history?provisional=true keeps only turns not yet mind-authored, with turn_id", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const db = await getDb();
    const mind = "test-turnsum-prov";
    const cookie = await mindCookie(mind);

    const auto = randomUUID(); // summarizer, deterministic (no author)
    const bare = randomUUID(); // summarizer, no metadata at all
    const mine = randomUUID(); // mind-authored
    await db.insert(summaries).values([
      {
        mind,
        period: "turn",
        period_key: auto,
        content: "auto row",
        metadata: JSON.stringify({ deterministic: true }),
      },
      { mind, period: "turn", period_key: bare, content: "bare row", metadata: null },
      {
        mind,
        period: "turn",
        period_key: mine,
        content: "my row",
        metadata: JSON.stringify({ author: "mind" }),
      },
    ]);

    const res = await app.request(`/api/minds/${mind}/history?provisional=true`, {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{ turn_id: string; content: string }>;
    const keys = new Set(body.map((r) => r.turn_id));
    assert.ok(keys.has(auto), "deterministic summarizer row is provisional");
    assert.ok(keys.has(bare), "row with no metadata is provisional");
    assert.ok(!keys.has(mine), "mind-authored row is excluded");
    // turn_id is surfaced so the mind can act on it via `volute mind summarize --turn`.
    assert.ok(body.every((r) => typeof r.turn_id === "string" && r.turn_id.length > 0));
  });

  it("history without provisional returns all turn summaries (mind-authored included)", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const db = await getDb();
    const mind = "test-turnsum-provall";
    const cookie = await mindCookie(mind);
    const auto = randomUUID();
    const mine = randomUUID();
    await db.insert(summaries).values([
      { mind, period: "turn", period_key: auto, content: "auto row", metadata: null },
      {
        mind,
        period: "turn",
        period_key: mine,
        content: "my row",
        metadata: JSON.stringify({ author: "mind" }),
      },
    ]);

    const res = await app.request(`/api/minds/${mind}/history`, {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{ turn_id: string }>;
    const keys = new Set(body.map((r) => r.turn_id));
    assert.ok(keys.has(auto) && keys.has(mine), "both rows returned when not provisional");
  });

  it("history?provisional=true is ignored outside the summary preset", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const db = await getDb();
    const mind = "test-turnsum-provconv";
    const cookie = await mindCookie(mind);
    // A conversation-preset row (mind_history) and a mind-authored turn summary.
    await db.insert(mindHistory).values({
      mind,
      type: "inbound",
      channel: "@x",
      sender: "x",
      content: "hello there",
    });
    await db.insert(summaries).values({
      mind,
      period: "turn",
      period_key: randomUUID(),
      content: "my row",
      metadata: JSON.stringify({ author: "mind" }),
    });

    const res = await app.request(
      `/api/minds/${mind}/history?preset=conversation&provisional=true`,
      {
        headers: { Cookie: `volute_session=${cookie}` },
      },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{ type: string; content: string }>;
    // The conversation preset reads mind_history; provisional has no effect there.
    assert.ok(body.some((r) => r.type === "inbound" && r.content === "hello there"));
    assert.ok(
      !body.some((r) => r.type === "summary"),
      "summary rows are not in the conversation preset",
    );
  });

  it("history?provisional=true works for an admin caller and stays scoped to the mind", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const db = await getDb();
    const mind = "test-turnsum-provadmin";
    const cookie = await adminCookie("test-turnsum-admin");
    const own = randomUUID();
    await db.insert(summaries).values([
      { mind, period: "turn", period_key: own, content: "auto row", metadata: null },
      {
        mind: "test-turnsum-elsewhere",
        period: "turn",
        period_key: randomUUID(),
        content: "other mind",
        metadata: null,
      },
    ]);

    const res = await app.request(`/api/minds/${mind}/history?provisional=true`, {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{ turn_id: string; content: string }>;
    assert.ok(body.some((r) => r.turn_id === own));
    assert.ok(!body.some((r) => r.content === "other mind"), "history is scoped to :name");
  });
});
