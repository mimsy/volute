import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Hono } from "hono";
import { getDb } from "../src/lib/db.js";
import { conversations, messages, sessions, users } from "../src/lib/schema.js";
import auth from "../src/web/api/auth.js";
import { deleteSession } from "../src/web/middleware/auth.js";

function createApp() {
  const app = new Hono();
  app.route("/api/auth", auth);
  return app;
}

async function cleanup() {
  const db = await getDb();
  await db.delete(sessions);
  await db.delete(messages);
  await db.delete(conversations);
  await db.delete(users);
}

function extractCookie(res: Response, name: string): string | undefined {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) return undefined;
  const match = setCookie.match(new RegExp(`${name}=([^;]+)`));
  return match?.[1];
}

describe("web auth routes", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("POST /api/auth/register — first user becomes admin with session", async () => {
    const app = createApp();
    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "pass123" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.role, "admin");
    assert.equal(body.username, "admin");
    // First user gets auto-login session cookie
    const cookie = extractCookie(res, "volute_session");
    assert.ok(cookie, "should set session cookie for admin");
    if (cookie) await deleteSession(cookie);
  });

  it("POST /api/auth/register — duplicate username returns 409", async () => {
    const app = createApp();
    await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "dupe", password: "pass" }),
    });
    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "dupe", password: "pass2" }),
    });
    assert.equal(res.status, 409);
  });

  it("POST /api/auth/login — valid credentials returns session cookie", async () => {
    const app = createApp();
    // Register first
    await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "loginuser", password: "pass123" }),
    });
    // Login
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "loginuser", password: "pass123" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.username, "loginuser");
    const cookie = extractCookie(res, "volute_session");
    assert.ok(cookie, "should set session cookie");
    if (cookie) await deleteSession(cookie);
  });

  it("POST /api/auth/login — invalid credentials returns 401", async () => {
    const app = createApp();
    await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "loginuser", password: "pass123" }),
    });
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "loginuser", password: "wrong" }),
    });
    assert.equal(res.status, 401);
  });

  it("GET /api/auth/me — with valid session cookie", async () => {
    const app = createApp();
    await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "meuser", password: "pass" }),
    });
    // Login to get session cookie
    const loginRes = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "meuser", password: "pass" }),
    });
    const cookie = extractCookie(loginRes, "volute_session");
    assert.ok(cookie);

    const res = await app.request("/api/auth/me", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.username, "meuser");
    if (cookie) await deleteSession(cookie);
  });

  it("GET /api/auth/me — without session returns 401", async () => {
    const app = createApp();
    const res = await app.request("/api/auth/me");
    assert.equal(res.status, 401);
  });

  it("POST /api/auth/logout — clears session", async () => {
    const app = createApp();
    await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "logoutuser", password: "pass" }),
    });
    const loginRes = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "logoutuser", password: "pass" }),
    });
    const cookie = extractCookie(loginRes, "volute_session");
    assert.ok(cookie);

    const logoutRes = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(logoutRes.status, 200);

    // Session should be invalid now
    const meRes = await app.request("/api/auth/me", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(meRes.status, 401);
  });
});
