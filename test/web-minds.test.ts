import assert from "node:assert/strict";
import { afterEach, before, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { approveUser, createUser, getOrCreateMindUser } from "../packages/daemon/src/lib/auth.js";
import {
  initMindManager,
  tryGetMindManager,
} from "../packages/daemon/src/lib/daemon/mind-manager.js";
import { generateMindToken } from "../packages/daemon/src/lib/daemon/mind-tokens.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { addMind, removeMind } from "../packages/daemon/src/lib/mind/registry.js";
import { users } from "../packages/daemon/src/lib/schema.js";
import { createSession, deleteSession } from "../packages/daemon/src/web/middleware/auth.js";

const TEST_USERNAMES = ["testmind-admin", "regular-user", "regular-user2"];

let sessionId: string;

async function cleanup() {
  const db = await getDb();
  for (const username of TEST_USERNAMES) {
    await db.delete(users).where(eq(users.username, username));
  }
}

async function setupAuth(): Promise<string> {
  const user = await createUser("testmind-admin", "pass");
  sessionId = await createSession(user.id);
  return sessionId;
}

// Helper to build POST request headers that pass CSRF
function postHeaders(cookie: string) {
  return {
    Cookie: `volute_session=${cookie}`,
    Origin: "http://localhost",
  };
}

describe("web minds routes", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("GET / — lists minds from registry", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request("/api/minds", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
  });

  it("GET /:name — 404 for missing mind", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request("/api/minds/nonexistent-mind-xyz", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(body.error);
  });

  it("POST /:name/start — 404 for missing mind", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request("http://localhost/api/minds/nonexistent-mind-xyz/start", {
      method: "POST",
      headers: postHeaders(cookie),
    });
    assert.equal(res.status, 404);
  });

  it("POST /:name/stop — 404 for missing mind", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request("http://localhost/api/minds/nonexistent-mind-xyz/stop", {
      method: "POST",
      headers: postHeaders(cookie),
    });
    assert.equal(res.status, 404);
  });

  it("GET / — requires auth (401 without cookie)", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request("/api/minds");
    assert.equal(res.status, 401);
  });

  it("GET / — Bearer token auth works for CLI requests", async () => {
    const token = "test-daemon-token";
    const prev = process.env.VOLUTE_DAEMON_TOKEN;
    process.env.VOLUTE_DAEMON_TOKEN = token;
    try {
      const { default: app } = await import("../packages/daemon/src/web/app.js");
      const res = await app.request("/api/minds", {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body));
    } finally {
      if (prev !== undefined) {
        process.env.VOLUTE_DAEMON_TOKEN = prev;
      } else {
        delete process.env.VOLUTE_DAEMON_TOKEN;
      }
    }
  });

  it("GET / — Bearer token rejects invalid token", async () => {
    const prev = process.env.VOLUTE_DAEMON_TOKEN;
    process.env.VOLUTE_DAEMON_TOKEN = "real-token";
    try {
      const { default: app } = await import("../packages/daemon/src/web/app.js");
      const res = await app.request("/api/minds", {
        headers: { Authorization: "Bearer wrong-token" },
      });
      assert.equal(res.status, 401);
    } finally {
      if (prev !== undefined) {
        process.env.VOLUTE_DAEMON_TOKEN = prev;
      } else {
        delete process.env.VOLUTE_DAEMON_TOKEN;
      }
    }
  });

  it("POST /:name/start — blocked by CSRF without origin", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request("/api/minds/test/start", {
      method: "POST",
    });
    // CSRF middleware rejects POSTs without matching origin
    assert.equal(res.status, 403);
  });

  it("POST /:name/start — non-admin user gets 403", async () => {
    // First user becomes admin
    await setupAuth();
    // Second user gets "pending" role, approve to "user"
    const user2 = await createUser("regular-user", "pass");
    await approveUser(user2.id);
    const cookie2 = await createSession(user2.id);

    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request("http://localhost/api/minds/nonexistent/start", {
      method: "POST",
      headers: {
        Cookie: `volute_session=${cookie2}`,
        Origin: "http://localhost",
      },
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, "Forbidden");

    await deleteSession(cookie2);
  });

  it("GET /:name/history/export — 404 for missing mind", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request("/api/minds/nonexistent-mind-xyz/history/export", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 404);
  });

  it("GET / — non-admin user can still list minds", async () => {
    await setupAuth();
    const user2 = await createUser("regular-user2", "pass");
    await approveUser(user2.id);
    const cookie2 = await createSession(user2.id);

    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request("/api/minds", {
      headers: { Cookie: `volute_session=${cookie2}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));

    await deleteSession(cookie2);
  });
});

describe("web minds roster", () => {
  const rosterMind = `roster-test-${Date.now()}`;

  // getMindStatus() consults the MindManager for run state; the daemon always
  // has it initialized before serving, so mirror that here.
  before(() => {
    if (!tryGetMindManager()) initMindManager();
  });

  async function rosterCleanup() {
    const db = await getDb();
    await db.delete(users).where(eq(users.username, rosterMind));
    try {
      await removeMind(rosterMind);
    } catch {}
  }

  beforeEach(rosterCleanup);
  afterEach(rosterCleanup);

  // Only profile-level fields belong in the roster — anything else (ports,
  // dirs, tokens, run internals) would leak system detail to untrusted minds.
  const ALLOWED_MIND_KEYS = new Set(["name", "displayName", "description", "avatar", "status"]);

  it("GET /roster — a mind can read the roster with its own token", async () => {
    await addMind(rosterMind, 4600);
    await getOrCreateMindUser(rosterMind);
    const token = generateMindToken(rosterMind);
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request("/api/minds/roster", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      minds: Array<Record<string, unknown>>;
      brains: Array<Record<string, unknown>>;
    };
    assert.ok(Array.isArray(body.minds));
    assert.ok(Array.isArray(body.brains));

    const entry = body.minds.find((m) => m.name === rosterMind);
    assert.ok(entry, "roster should include the test mind");
    assert.ok(typeof entry.status === "string");
  });

  it("GET /roster — exposes only profile-level fields, no ports/dirs/tokens", async () => {
    await addMind(rosterMind, 4600);
    await getOrCreateMindUser(rosterMind);
    const token = generateMindToken(rosterMind);
    const { default: app } = await import("../packages/daemon/src/web/app.js");

    const res = await app.request("/api/minds/roster", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as { minds: Array<Record<string, unknown>> };
    for (const entry of body.minds) {
      for (const key of Object.keys(entry)) {
        assert.ok(ALLOWED_MIND_KEYS.has(key), `roster mind entry leaked non-profile field: ${key}`);
      }
    }
  });

  it("GET /roster — requires auth (401 without credentials)", async () => {
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    const res = await app.request("/api/minds/roster");
    assert.equal(res.status, 401);
  });
});
