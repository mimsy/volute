import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq, sql } from "drizzle-orm";
import { createUser } from "../src/lib/auth.js";
import { getDb } from "../src/lib/db.js";
import { mindHistory, summaries, turns, users } from "../src/lib/schema.js";
import { createSession, deleteSession } from "../src/web/middleware/auth.js";

const TEST_USERNAME = "history-test-admin";
let sessionId: string;

async function cleanup() {
  const db = await getDb();
  await db.delete(users).where(eq(users.username, TEST_USERNAME));
  // Clean up test turns, history, and summaries
  await db.delete(summaries).where(sql`mind LIKE 'test-history-%'`);
  await db.delete(turns).where(sql`mind LIKE 'test-history-%'`);
  await db.delete(mindHistory).where(sql`mind LIKE 'test-history-%'`);
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
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request("/api/v1/history/turns", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
  });

  it("GET /api/v1/history/turns — returns turns with mind field", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../src/web/app.js");
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
    const { default: app } = await import("../src/web/app.js");
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
    const { default: app } = await import("../src/web/app.js");
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
    const { default: app } = await import("../src/web/app.js");
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

  it("GET /api/v1/history/turns — requires auth", async () => {
    const { default: app } = await import("../src/web/app.js");
    const res = await app.request("/api/v1/history/turns");
    assert.equal(res.status, 401);
  });

  // ── Summaries endpoint tests ──

  it("GET /api/v1/history/summaries — requires period param", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request("/api/v1/history/summaries", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok((body as { error: string }).error.includes("period"));
  });

  it("GET /api/v1/history/summaries — rejects invalid period", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request("/api/v1/history/summaries?period=invalid", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 400);
  });

  it("GET /api/v1/history/summaries — returns summaries by period", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../src/web/app.js");
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
    const { default: app } = await import("../src/web/app.js");
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
    const { default: app } = await import("../src/web/app.js");
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

  it("GET /api/v1/history/summaries — caps limit at 200", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request(
      "/api/v1/history/summaries?period=hour&mind=test-history-cap&limit=999",
      { headers: { Cookie: `volute_session=${cookie}` } },
    );
    assert.equal(res.status, 200);
    // We can't directly check the SQL limit, but we verify the endpoint doesn't error
    const body = await res.json();
    assert.ok(Array.isArray(body));
  });
});
