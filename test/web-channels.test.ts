import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createUser } from "../src/lib/auth.js";
import { getDb } from "../src/lib/db.js";
import { addMind, removeMind } from "../src/lib/registry.js";
import { conversations, messages, sessions, users } from "../src/lib/schema.js";
import { createSession } from "../src/web/middleware/auth.js";

const TEST_AGENT = "channels-test-agent";

let sessionId: string;

async function cleanup() {
  const db = await getDb();
  await db.delete(sessions);
  await db.delete(messages);
  await db.delete(conversations);
  await db.delete(users);
  try {
    removeMind(TEST_AGENT);
  } catch {
    // ignore if not registered
  }
}

async function setupAuth(): Promise<string> {
  const user = await createUser("channels-admin", "pass");
  sessionId = await createSession(user.id);
  return sessionId;
}

function postHeaders(cookie: string) {
  return {
    Cookie: `volute_session=${cookie}`,
    Origin: "http://localhost",
    "Content-Type": "application/json",
  };
}

function getHeaders(cookie: string) {
  return {
    Cookie: `volute_session=${cookie}`,
  };
}

describe("web channels routes", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  // --- send ---

  it("POST /:name/channels/send — 404 for nonexistent agent", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request("http://localhost/api/minds/nonexistent-ch-agent/channels/send", {
      method: "POST",
      headers: postHeaders(cookie),
      body: JSON.stringify({ platform: "discord", uri: "test:chan", message: "hi" }),
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error);
  });

  it("POST /:name/channels/send — 400 for invalid platform", async () => {
    const cookie = await setupAuth();
    addMind(TEST_AGENT, 4160);
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request(`http://localhost/api/minds/${TEST_AGENT}/channels/send`, {
      method: "POST",
      headers: postHeaders(cookie),
      body: JSON.stringify({ platform: "nonexistent-platform", uri: "test:chan", message: "hi" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes("No driver"));
  });

  // --- read ---

  it("GET /:name/channels/read — 404 for nonexistent agent", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request(
      "/api/minds/nonexistent-ch-agent/channels/read?platform=discord&uri=test:chan",
      { headers: getHeaders(cookie) },
    );
    assert.equal(res.status, 404);
  });

  it("GET /:name/channels/read — 400 when missing platform or uri", async () => {
    const cookie = await setupAuth();
    addMind(TEST_AGENT, 4160);
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request(`/api/minds/${TEST_AGENT}/channels/read`, {
      headers: getHeaders(cookie),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes("required"));
  });

  it("GET /:name/channels/read — 400 for invalid platform", async () => {
    const cookie = await setupAuth();
    addMind(TEST_AGENT, 4160);
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request(
      `/api/minds/${TEST_AGENT}/channels/read?platform=bogus&uri=test`,
      { headers: getHeaders(cookie) },
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes("No driver"));
  });

  // --- list ---

  it("GET /:name/channels/list — 404 for nonexistent agent", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request("/api/minds/nonexistent-ch-agent/channels/list", {
      headers: getHeaders(cookie),
    });
    assert.equal(res.status, 404);
  });

  it("GET /:name/channels/list — returns object keyed by platform", async () => {
    const cookie = await setupAuth();
    addMind(TEST_AGENT, 4160);
    const { default: app } = await import("../src/web/app.js");

    // This will attempt to list conversations for all platforms.
    // Platforms without credentials will return errors in their arrays,
    // but the overall response should be 200 with an object.
    const res = await app.request(`/api/minds/${TEST_AGENT}/channels/list`, {
      headers: getHeaders(cookie),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body, "object");
    assert.ok(!Array.isArray(body));
  });

  // --- users ---

  it("GET /:name/channels/users — 404 for nonexistent agent", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request(
      "/api/minds/nonexistent-ch-agent/channels/users?platform=discord",
      { headers: getHeaders(cookie) },
    );
    assert.equal(res.status, 404);
  });

  it("GET /:name/channels/users — 400 when missing platform", async () => {
    const cookie = await setupAuth();
    addMind(TEST_AGENT, 4160);
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request(`/api/minds/${TEST_AGENT}/channels/users`, {
      headers: getHeaders(cookie),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes("platform required"));
  });

  it("GET /:name/channels/users — 400 for platform without listUsers", async () => {
    const cookie = await setupAuth();
    addMind(TEST_AGENT, 4160);
    const { default: app } = await import("../src/web/app.js");

    // 'system' channel has no driver at all
    const res = await app.request(`/api/minds/${TEST_AGENT}/channels/users?platform=system`, {
      headers: getHeaders(cookie),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes("does not support"));
  });

  // --- create ---

  it("POST /:name/channels/create — 404 for nonexistent agent", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request(
      "http://localhost/api/minds/nonexistent-ch-agent/channels/create",
      {
        method: "POST",
        headers: postHeaders(cookie),
        body: JSON.stringify({ platform: "discord", participants: ["user1"] }),
      },
    );
    assert.equal(res.status, 404);
  });

  it("POST /:name/channels/create — 400 for platform without createConversation", async () => {
    const cookie = await setupAuth();
    addMind(TEST_AGENT, 4160);
    const { default: app } = await import("../src/web/app.js");

    // 'system' has no driver
    const res = await app.request(`http://localhost/api/minds/${TEST_AGENT}/channels/create`, {
      method: "POST",
      headers: postHeaders(cookie),
      body: JSON.stringify({ platform: "system", participants: ["user1"] }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes("does not support"));
  });

  // --- auth gating ---

  it("POST /:name/channels/send — requires auth (401 without cookie)", async () => {
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request(`http://localhost/api/minds/${TEST_AGENT}/channels/send`, {
      method: "POST",
      headers: { Origin: "http://localhost", "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "discord", uri: "test:chan", message: "hi" }),
    });
    assert.equal(res.status, 401);
  });

  it("GET /:name/channels/read — requires auth (401 without cookie)", async () => {
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request(
      `/api/minds/${TEST_AGENT}/channels/read?platform=discord&uri=test`,
    );
    assert.equal(res.status, 401);
  });
});
