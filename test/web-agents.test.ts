import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createUser } from "../src/lib/auth.js";
import { getDb } from "../src/lib/db.js";
import { conversations, messages, users } from "../src/lib/schema.js";
import { createSession, deleteSession } from "../src/web/middleware/auth.js";

let sessionId: string;

async function cleanup() {
  const db = await getDb();
  await db.delete(messages);
  await db.delete(conversations);
  await db.delete(users);
  if (sessionId) deleteSession(sessionId);
}

async function setupAuth(): Promise<string> {
  const user = await createUser("testagent-admin", "pass");
  sessionId = createSession(user.id);
  return sessionId;
}

// Helper to build POST request headers that pass CSRF
function postHeaders(cookie: string) {
  return {
    Cookie: `volute_session=${cookie}`,
    Origin: "http://localhost",
  };
}

describe("web agents routes", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("GET / — lists agents from registry", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request("/api/agents", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
  });

  it("GET /:name — 404 for missing agent", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request("/api/agents/nonexistent-agent-xyz", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(body.error);
  });

  it("POST /:name/start — 404 for missing agent", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request("http://localhost/api/agents/nonexistent-agent-xyz/start", {
      method: "POST",
      headers: postHeaders(cookie),
    });
    assert.equal(res.status, 404);
  });

  it("POST /:name/stop — 404 for missing agent", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request("http://localhost/api/agents/nonexistent-agent-xyz/stop", {
      method: "POST",
      headers: postHeaders(cookie),
    });
    assert.equal(res.status, 404);
  });

  it("GET / — requires auth (401 without cookie)", async () => {
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request("/api/agents");
    assert.equal(res.status, 401);
  });

  it("GET / — Bearer token auth works for CLI requests", async () => {
    const token = "test-daemon-token";
    const prev = process.env.VOLUTE_DAEMON_TOKEN;
    process.env.VOLUTE_DAEMON_TOKEN = token;
    try {
      const { default: app } = await import("../src/web/app.js");
      const res = await app.request("/api/agents", {
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
      const { default: app } = await import("../src/web/app.js");
      const res = await app.request("/api/agents", {
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
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request("/api/agents/test/start", {
      method: "POST",
    });
    // CSRF middleware rejects POSTs without matching origin
    assert.equal(res.status, 403);
  });
});
