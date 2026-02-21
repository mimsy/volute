import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Hono } from "hono";
import { getDb } from "../src/lib/db.js";
import { PROMPT_DEFAULTS, PROMPT_KEYS } from "../src/lib/prompts.js";
import { sessions, systemPrompts, users } from "../src/lib/schema.js";
import prompts from "../src/web/api/prompts.js";
import { type AuthEnv, authMiddleware } from "../src/web/middleware/auth.js";

function createApp() {
  const app = new Hono<AuthEnv>();
  app.use("/*", authMiddleware);
  app.route("/", prompts);
  return app;
}

let adminCookie: string;

async function setup() {
  const db = await getDb();
  await db.delete(systemPrompts);
  await db.delete(sessions);
  await db.delete(users);

  // Create admin user and session
  const [user] = await db
    .insert(users)
    .values({ username: "admin", password_hash: "x", role: "admin" })
    .returning();
  const sessionId = crypto.randomUUID();
  await db.insert(sessions).values({ id: sessionId, userId: user.id, createdAt: Date.now() });
  adminCookie = `volute_session=${sessionId}`;
}

async function cleanup() {
  const db = await getDb();
  await db.delete(systemPrompts);
  await db.delete(sessions);
  await db.delete(users);
}

describe("web prompts API", () => {
  beforeEach(setup);
  afterEach(cleanup);

  it("GET / returns all default prompts when DB is empty", async () => {
    const app = createApp();
    const res = await app.request("/", {
      headers: { Cookie: adminCookie },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.length, PROMPT_KEYS.length);
    for (const p of body) {
      assert.equal(p.isCustom, false);
      assert.equal(typeof p.content, "string");
      assert.equal(typeof p.description, "string");
      assert.ok(Array.isArray(p.variables));
      assert.ok(["creation", "system", "mind"].includes(p.category));
    }
  });

  it("PUT /:key stores custom, GET reflects with isCustom: true", async () => {
    const app = createApp();
    const putRes = await app.request("/restart_message", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ content: "Custom restart" }),
    });
    assert.equal(putRes.status, 200);

    const getRes = await app.request("/", {
      headers: { Cookie: adminCookie },
    });
    const body = await getRes.json();
    const prompt = body.find((p: { key: string }) => p.key === "restart_message");
    assert.equal(prompt.content, "Custom restart");
    assert.equal(prompt.isCustom, true);
  });

  it("DELETE /:key resets to default", async () => {
    const app = createApp();

    // First set a custom value
    await app.request("/restart_message", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ content: "Custom restart" }),
    });

    // Delete it
    const delRes = await app.request("/restart_message", {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    assert.equal(delRes.status, 200);

    // Verify it's back to default
    const getRes = await app.request("/", {
      headers: { Cookie: adminCookie },
    });
    const body = await getRes.json();
    const prompt = body.find((p: { key: string }) => p.key === "restart_message");
    assert.equal(prompt.content, PROMPT_DEFAULTS.restart_message.content);
    assert.equal(prompt.isCustom, false);
  });

  it("PUT unknown key returns 404", async () => {
    const app = createApp();
    const res = await app.request("/nonexistent_key", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ content: "test" }),
    });
    assert.equal(res.status, 404);
  });

  it("DELETE unknown key returns 404", async () => {
    const app = createApp();
    const res = await app.request("/nonexistent_key", {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    assert.equal(res.status, 404);
  });

  it("unauthenticated request returns 401", async () => {
    const app = createApp();
    const res = await app.request("/");
    assert.equal(res.status, 401);
  });

  it("non-admin PUT returns 403", async () => {
    const app = createApp();
    const db = await getDb();
    const [viewer] = await db
      .insert(users)
      .values({ username: "viewer", password_hash: "x", role: "viewer" })
      .returning();
    const viewerSessionId = crypto.randomUUID();
    await db
      .insert(sessions)
      .values({ id: viewerSessionId, userId: viewer.id, createdAt: Date.now() });

    const res = await app.request("/restart_message", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: `volute_session=${viewerSessionId}`,
      },
      body: JSON.stringify({ content: "test" }),
    });
    assert.equal(res.status, 403);
  });

  it("PUT upserts existing custom value", async () => {
    const app = createApp();

    // Set initial custom value
    await app.request("/restart_message", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ content: "Version 1" }),
    });

    // Update it
    await app.request("/restart_message", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ content: "Version 2" }),
    });

    // Verify latest
    const getRes = await app.request("/", {
      headers: { Cookie: adminCookie },
    });
    const body = await getRes.json();
    const prompt = body.find((p: { key: string }) => p.key === "restart_message");
    assert.equal(prompt.content, "Version 2");
  });
});
