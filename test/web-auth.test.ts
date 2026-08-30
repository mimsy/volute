import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { issueApiToken, revokeApiToken } from "../packages/daemon/src/lib/api-tokens.js";
import {
  approveUser,
  createUser,
  getOrCreateMindUser,
  setUserRole,
} from "../packages/daemon/src/lib/auth.js";
import {
  generateMindToken,
  revokeMindToken,
} from "../packages/daemon/src/lib/daemon/mind-tokens.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { users } from "../packages/daemon/src/lib/schema.js";
import auth from "../packages/daemon/src/web/api/auth.js";
import {
  _sessionCacheForTest,
  type AuthEnv,
  authMiddleware,
  cleanExpiredSessions,
  createSession,
  deleteSession,
} from "../packages/daemon/src/web/middleware/auth.js";

const TOKEN_MIND = "me-token-mind";
const TEST_USERNAMES = ["admin", "dupe", "loginuser", "meuser", "logoutuser", TOKEN_MIND];

function createApp() {
  const app = new Hono();
  app.route("/api/v1/auth", auth);
  return app;
}

async function cleanup() {
  const db = await getDb();
  for (const username of TEST_USERNAMES) {
    await db.delete(users).where(eq(users.username, username));
  }
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

  it("POST /api/v1/auth/register — first user becomes admin with session", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/auth/register", {
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

  it("POST /api/v1/auth/register — duplicate username returns 409", async () => {
    const app = createApp();
    await app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "dupe", password: "pass" }),
    });
    const res = await app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "dupe", password: "pass2" }),
    });
    assert.equal(res.status, 409);
  });

  it("POST /api/v1/auth/login — valid credentials returns session cookie", async () => {
    const app = createApp();
    // Register first
    await app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "loginuser", password: "pass123" }),
    });
    // Login
    const res = await app.request("/api/v1/auth/login", {
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

  it("POST /api/v1/auth/login — invalid credentials returns 401", async () => {
    const app = createApp();
    await app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "loginuser", password: "pass123" }),
    });
    const res = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "loginuser", password: "wrong" }),
    });
    assert.equal(res.status, 401);
  });

  it("GET /api/v1/auth/me — with valid session cookie", async () => {
    const app = createApp();
    await app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "meuser", password: "pass" }),
    });
    // Login to get session cookie
    const loginRes = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "meuser", password: "pass" }),
    });
    const cookie = extractCookie(loginRes, "volute_session");
    assert.ok(cookie);

    const res = await app.request("/api/v1/auth/me", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.username, "meuser");
    if (cookie) await deleteSession(cookie);
  });

  it("GET /api/v1/auth/me — without session returns 401", async () => {
    const app = createApp();
    const res = await app.request("/api/v1/auth/me");
    assert.equal(res.status, 401);
  });

  // #753: /me hand-rolled session-token resolution, so a validly-authenticated
  // vmt_ principal — the credential an external mind is handed — was told it
  // wasn't logged in. It now shares authMiddleware's resolver.
  it("GET /api/v1/auth/me — identifies a vmt_ API token holder", async () => {
    const mindUser = await getOrCreateMindUser(TOKEN_MIND);
    const { token } = await issueApiToken(mindUser.id, "who-am-i");

    const res = await createApp().request("/api/v1/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json();
    assert.equal(body.username, TOKEN_MIND);
    assert.equal(body.id, mindUser.id);
    assert.equal(body.role, "user");
    // Response shape is unchanged — the same six fields, nothing more.
    assert.deepEqual(Object.keys(body).sort(), [
      "avatar",
      "description",
      "display_name",
      "id",
      "role",
      "username",
    ]);
  });

  it("GET /api/v1/auth/me — rejects a revoked vmt_ token", async () => {
    const mindUser = await getOrCreateMindUser(TOKEN_MIND);
    const { id, token } = await issueApiToken(mindUser.id, "short-lived");
    await revokeApiToken(mindUser.id, id);

    const res = await createApp().request("/api/v1/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 401);
  });

  it("GET /api/v1/auth/me — identifies a session-token Bearer (CLI login)", async () => {
    const user = await createUser("meuser", "pass");
    const sessionId = await createSession(user.id);

    const res = await createApp().request("/api/v1/auth/me", {
      headers: { Authorization: `Bearer ${sessionId}` },
    });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal((await res.json()).username, "meuser");
    await deleteSession(sessionId);
  });

  // The shared resolver can answer from a 5-minute cache, so /me re-reads the row.
  // Without that, an admin approving an account leaves the user stuck on the
  // awaiting-approval screen (LoginPage gates on role === "pending") until the TTL.
  it("GET /api/v1/auth/me — reflects an approval made after the session was cached", async () => {
    const user = await createUser("meuser", "pass");
    await setUserRole(user.id, "pending");
    const sessionId = await createSession(user.id);
    const app = createApp();

    // Warm the session cache with the pending snapshot.
    const before = await app.request("/api/v1/auth/me", {
      headers: { Cookie: `volute_session=${sessionId}` },
    });
    assert.equal((await before.json()).role, "pending");

    await approveUser(user.id);

    const after = await app.request("/api/v1/auth/me", {
      headers: { Cookie: `volute_session=${sessionId}` },
    });
    assert.equal(after.status, 200, await after.clone().text());
    assert.equal((await after.json()).role, "user", "approval must land on the next refresh");

    await deleteSession(sessionId);
  });

  it("GET /api/v1/auth/me — 401s when the cached user's row is gone", async () => {
    const user = await createUser("meuser", "pass");
    const sessionId = await createSession(user.id);
    const app = createApp();

    const before = await app.request("/api/v1/auth/me", {
      headers: { Cookie: `volute_session=${sessionId}` },
    });
    assert.equal(before.status, 200);

    const db = await getDb();
    await db.delete(users).where(eq(users.id, user.id));

    const after = await app.request("/api/v1/auth/me", {
      headers: { Cookie: `volute_session=${sessionId}` },
    });
    assert.equal(after.status, 401, "a deleted user must not be served from cache");

    await deleteSession(sessionId);
  });

  // Deliberate policy split: authMiddleware 403s a pending account, but /me still
  // answers it, or a pending user reloading the page can't be told they're pending.
  it("GET /api/v1/auth/me — still identifies a pending user", async () => {
    const user = await createUser("meuser", "pass");
    await setUserRole(user.id, "pending");
    const sessionId = await createSession(user.id);

    const res = await createApp().request("/api/v1/auth/me", {
      headers: { Cookie: `volute_session=${sessionId}` },
    });
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json();
    assert.equal(body.username, "meuser");
    assert.equal(body.role, "pending");
    await deleteSession(sessionId);
  });

  it("POST /api/v1/auth/logout — clears session", async () => {
    const app = createApp();
    await app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "logoutuser", password: "pass" }),
    });
    const loginRes = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "logoutuser", password: "pass" }),
    });
    const cookie = extractCookie(loginRes, "volute_session");
    assert.ok(cookie);

    const logoutRes = await app.request("/api/v1/auth/logout", {
      method: "POST",
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(logoutRes.status, 200);

    // Session should be invalid now
    const meRes = await app.request("/api/v1/auth/me", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(meRes.status, 401);
  });
});

describe("cleanExpiredSessions cache sweep", () => {
  it("evicts expired session-cache entries and keeps live ones", async () => {
    const user = { id: 4242, username: "cache-sweep", role: "user" } as any;
    _sessionCacheForTest.set("expired-sid", {
      userId: user.id,
      user,
      expires: Date.now() - 1000,
    });
    _sessionCacheForTest.set("live-sid", {
      userId: user.id,
      user,
      expires: Date.now() + 60_000,
    });

    await cleanExpiredSessions();

    assert.equal(_sessionCacheForTest.has("expired-sid"), false, "expired entry swept");
    assert.equal(_sessionCacheForTest.has("live-sid"), true, "live entry retained");

    _sessionCacheForTest.delete("live-sid");
  });
});

/**
 * resolvePrincipal is the single credential-resolution path shared by
 * authMiddleware and GET /auth/me (#753). These pin the two things the
 * extraction restructured and that no route test covers: which branches
 * propagate the X-Volute-Thread session, and the pending-account gate that
 * moved from per-branch to one place.
 */
describe("authMiddleware principal resolution", () => {
  const MIND = "principal-mind";
  const HUMAN = "principal-human";

  async function cleanupPrincipals() {
    const db = await getDb();
    for (const username of [MIND, HUMAN]) {
      await db.delete(users).where(eq(users.username, username));
    }
  }

  beforeEach(cleanupPrincipals);
  afterEach(cleanupPrincipals);

  /** Echoes back who the caller is and which mind session was captured. */
  function probeApp() {
    const app = new Hono<AuthEnv>();
    app.use("/probe", authMiddleware);
    app.get("/probe", (c) =>
      c.json({ caller: c.get("user").username, mindSession: c.get("mindSession") ?? null }),
    );
    return app;
  }

  it("captures X-Volute-Thread for the daemon token", async () => {
    const prev = process.env.VOLUTE_DAEMON_TOKEN;
    process.env.VOLUTE_DAEMON_TOKEN = "daemon-probe-token";
    try {
      const res = await probeApp().request("/probe", {
        headers: {
          Authorization: "Bearer daemon-probe-token",
          "X-Volute-Thread": "sess-daemon",
        },
      });
      assert.equal(res.status, 200, await res.clone().text());
      assert.deepEqual(await res.json(), { caller: "daemon", mindSession: "sess-daemon" });
    } finally {
      if (prev === undefined) delete process.env.VOLUTE_DAEMON_TOKEN;
      else process.env.VOLUTE_DAEMON_TOKEN = prev;
    }
  });

  it("captures X-Volute-Thread for a mind token", async () => {
    await getOrCreateMindUser(MIND);
    const token = generateMindToken(MIND);
    try {
      const res = await probeApp().request("/probe", {
        headers: { Authorization: `Bearer ${token}`, "X-Volute-Thread": "sess-mind" },
      });
      assert.equal(res.status, 200, await res.clone().text());
      assert.deepEqual(await res.json(), { caller: MIND, mindSession: "sess-mind" });
    } finally {
      revokeMindToken(MIND);
    }
  });

  // Turn attribution belongs to the daemon and to live mind processes. A durable
  // vmt_ credential is not a turn, so it must not claim one by sending the header.
  it("does not capture X-Volute-Thread for a vmt_ API token", async () => {
    const mindUser = await getOrCreateMindUser(MIND);
    const { token } = await issueApiToken(mindUser.id, "thread-probe");

    const res = await probeApp().request("/probe", {
      headers: { Authorization: `Bearer ${token}`, "X-Volute-Thread": "sess-external" },
    });
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(await res.json(), { caller: MIND, mindSession: null });
  });

  it("403s a pending account on both the cookie and vmt_ branches", async () => {
    const user = await createUser(HUMAN, "pw-123456");
    await setUserRole(user.id, "pending");
    const sessionId = await createSession(user.id);
    const { token } = await issueApiToken(user.id, "pending-probe");

    const viaCookie = await probeApp().request("/probe", {
      headers: { Cookie: `volute_session=${sessionId}` },
    });
    assert.equal(viaCookie.status, 403);
    assert.equal((await viaCookie.json()).error, "Account pending approval");

    const viaToken = await probeApp().request("/probe", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(viaToken.status, 403);

    await deleteSession(sessionId);
  });

  it("falls through to the cookie when a Bearer token resolves to nothing", async () => {
    const user = await createUser(HUMAN, "pw-123456");
    const sessionId = await createSession(user.id);

    const res = await probeApp().request("/probe", {
      headers: {
        Authorization: "Bearer vmt_not_a_real_token",
        Cookie: `volute_session=${sessionId}`,
      },
    });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal((await res.json()).caller, HUMAN);

    await deleteSession(sessionId);
  });
});
