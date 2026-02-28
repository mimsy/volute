import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mindEnvPath, readEnv, sharedEnvPath, writeEnv } from "@volute/shared/env";
import { addMind, removeMind } from "@volute/shared/registry";
import { approveUser, createUser } from "../src/lib/auth.js";
import { getDb } from "../src/lib/db.js";
import { conversations, messages, sessions, users } from "../src/lib/schema.js";
import { createSession, deleteSession } from "../src/web/middleware/auth.js";

const TEST_MIND = "env-test-mind";

let sessionId: string;

async function cleanup() {
  const db = await getDb();
  await db.delete(sessions);
  await db.delete(messages);
  await db.delete(conversations);
  await db.delete(users);
  // Clean up env files
  writeEnv(sharedEnvPath(), {});
  writeEnv(mindEnvPath(TEST_MIND), {});
  try {
    removeMind(TEST_MIND);
  } catch {
    // ignore if not registered
  }
}

async function setupAuth(): Promise<string> {
  const user = await createUser("env-admin", "pass");
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

describe("web env routes — mind-scoped", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("GET /:name/env — returns shared and mind env", async () => {
    const cookie = await setupAuth();
    addMind(TEST_MIND, 4150);
    writeEnv(sharedEnvPath(), { SHARED_KEY: "shared_val" });
    writeEnv(mindEnvPath(TEST_MIND), { MIND_KEY: "mind_val" });

    const { default: app } = await import("../src/web/app.js");

    const res = await app.request(`/api/minds/${TEST_MIND}/env`, {
      headers: getHeaders(cookie),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      shared: Record<string, string>;
      mind: Record<string, string>;
    };
    assert.equal(body.shared.SHARED_KEY, "shared_val");
    assert.equal(body.mind.MIND_KEY, "mind_val");
  });

  it("GET /:name/env — 404 for nonexistent mind", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request("/api/minds/nonexistent-env-mind/env", {
      headers: getHeaders(cookie),
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error);
  });

  it("PUT /:name/env/:key — sets mind env var", async () => {
    const cookie = await setupAuth();
    addMind(TEST_MIND, 4150);

    const { default: app } = await import("../src/web/app.js");

    const res = await app.request(`http://localhost/api/minds/${TEST_MIND}/env/MY_KEY`, {
      method: "PUT",
      headers: postHeaders(cookie),
      body: JSON.stringify({ value: "my_value" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.equal(body.ok, true);

    // Verify it was written
    const env = readEnv(mindEnvPath(TEST_MIND));
    assert.equal(env.MY_KEY, "my_value");
  });

  it("GET /:name/env/:key — returns value after setting", async () => {
    const cookie = await setupAuth();
    addMind(TEST_MIND, 4150);
    writeEnv(mindEnvPath(TEST_MIND), { TEST_VAR: "hello" });

    const { default: app } = await import("../src/web/app.js");

    const res = await app.request(`/api/minds/${TEST_MIND}/env/TEST_VAR`, {
      headers: getHeaders(cookie),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { value: string };
    assert.equal(body.value, "hello");
  });

  it("GET /:name/env/:key — 404 for missing key", async () => {
    const cookie = await setupAuth();
    addMind(TEST_MIND, 4150);

    const { default: app } = await import("../src/web/app.js");

    const res = await app.request(`/api/minds/${TEST_MIND}/env/NONEXISTENT_KEY`, {
      headers: getHeaders(cookie),
    });
    assert.equal(res.status, 404);
  });

  it("GET /:name/env/:key — returns merged value from shared env", async () => {
    const cookie = await setupAuth();
    addMind(TEST_MIND, 4150);
    writeEnv(sharedEnvPath(), { FROM_SHARED: "shared_val" });

    const { default: app } = await import("../src/web/app.js");

    const res = await app.request(`/api/minds/${TEST_MIND}/env/FROM_SHARED`, {
      headers: getHeaders(cookie),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { value: string };
    assert.equal(body.value, "shared_val");
  });

  it("DELETE /:name/env/:key — removes mind env var", async () => {
    const cookie = await setupAuth();
    addMind(TEST_MIND, 4150);
    writeEnv(mindEnvPath(TEST_MIND), { TO_DELETE: "val" });

    const { default: app } = await import("../src/web/app.js");

    const res = await app.request(`http://localhost/api/minds/${TEST_MIND}/env/TO_DELETE`, {
      method: "DELETE",
      headers: {
        Cookie: `volute_session=${cookie}`,
        Origin: "http://localhost",
      },
    });
    assert.equal(res.status, 200);

    // Verify it was removed
    const env = readEnv(mindEnvPath(TEST_MIND));
    assert.equal(env.TO_DELETE, undefined);
  });

  it("DELETE /:name/env/:key — 404 for nonexistent key", async () => {
    const cookie = await setupAuth();
    addMind(TEST_MIND, 4150);
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request(`http://localhost/api/minds/${TEST_MIND}/env/NONEXISTENT`, {
      method: "DELETE",
      headers: {
        Cookie: `volute_session=${cookie}`,
        Origin: "http://localhost",
      },
    });
    assert.equal(res.status, 404);
  });

  it("PUT /:name/env/:key — 400 for missing value field", async () => {
    const cookie = await setupAuth();
    addMind(TEST_MIND, 4150);
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request(`http://localhost/api/minds/${TEST_MIND}/env/KEY`, {
      method: "PUT",
      headers: postHeaders(cookie),
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes("value"));
  });

  it("PUT /:name/env/:key — 404 for nonexistent mind", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request("http://localhost/api/minds/nonexistent-env-mind/env/KEY", {
      method: "PUT",
      headers: postHeaders(cookie),
      body: JSON.stringify({ value: "val" }),
    });
    assert.equal(res.status, 404);
  });

  it("DELETE /:name/env/:key — 404 for nonexistent mind", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request("http://localhost/api/minds/nonexistent-env-mind/env/KEY", {
      method: "DELETE",
      headers: {
        Cookie: `volute_session=${cookie}`,
        Origin: "http://localhost",
      },
    });
    assert.equal(res.status, 404);
  });

  it("PUT /:name/env/:key — requires auth (401 without cookie)", async () => {
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request(`http://localhost/api/minds/${TEST_MIND}/env/KEY`, {
      method: "PUT",
      headers: { Origin: "http://localhost", "Content-Type": "application/json" },
      body: JSON.stringify({ value: "val" }),
    });
    assert.equal(res.status, 401);
  });

  it("PUT /:name/env/:key — non-admin user gets 403", async () => {
    await setupAuth();
    const user2 = await createUser("regular-env-user", "pass");
    await approveUser(user2.id);
    const cookie2 = await createSession(user2.id);

    addMind(TEST_MIND, 4150);
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request(`http://localhost/api/minds/${TEST_MIND}/env/KEY`, {
      method: "PUT",
      headers: {
        Cookie: `volute_session=${cookie2}`,
        Origin: "http://localhost",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ value: "val" }),
    });
    assert.equal(res.status, 403);
    await deleteSession(cookie2);
  });
});

describe("web env routes — shared", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("GET /api/env — returns shared env dict", async () => {
    const cookie = await setupAuth();
    writeEnv(sharedEnvPath(), { GLOBAL_KEY: "global_val" });

    const { default: app } = await import("../src/web/app.js");

    const res = await app.request("/api/env", {
      headers: getHeaders(cookie),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, string>;
    assert.equal(body.GLOBAL_KEY, "global_val");
  });

  it("GET /api/env — returns empty object when no env set", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request("/api/env", {
      headers: getHeaders(cookie),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, string>;
    assert.deepEqual(body, {});
  });

  it("PUT /api/env/:key — sets shared env var", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request("http://localhost/api/env/NEW_KEY", {
      method: "PUT",
      headers: postHeaders(cookie),
      body: JSON.stringify({ value: "new_value" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.equal(body.ok, true);

    // Verify it was written
    const env = readEnv(sharedEnvPath());
    assert.equal(env.NEW_KEY, "new_value");
  });

  it("DELETE /api/env/:key — removes shared env var", async () => {
    const cookie = await setupAuth();
    writeEnv(sharedEnvPath(), { DEL_KEY: "to_delete" });

    const { default: app } = await import("../src/web/app.js");

    const res = await app.request("http://localhost/api/env/DEL_KEY", {
      method: "DELETE",
      headers: {
        Cookie: `volute_session=${cookie}`,
        Origin: "http://localhost",
      },
    });
    assert.equal(res.status, 200);

    const env = readEnv(sharedEnvPath());
    assert.equal(env.DEL_KEY, undefined);
  });

  it("DELETE /api/env/:key — 404 for nonexistent key", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request("http://localhost/api/env/NONEXISTENT", {
      method: "DELETE",
      headers: {
        Cookie: `volute_session=${cookie}`,
        Origin: "http://localhost",
      },
    });
    assert.equal(res.status, 404);
  });

  it("PUT /api/env/:key — 400 for missing value field", async () => {
    const cookie = await setupAuth();
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request("http://localhost/api/env/KEY", {
      method: "PUT",
      headers: postHeaders(cookie),
      body: JSON.stringify({ wrong: "field" }),
    });
    assert.equal(res.status, 400);
  });

  it("PUT /api/env/:key — requires auth (401 without cookie)", async () => {
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request("http://localhost/api/env/KEY", {
      method: "PUT",
      headers: { Origin: "http://localhost", "Content-Type": "application/json" },
      body: JSON.stringify({ value: "val" }),
    });
    assert.equal(res.status, 401);
  });

  it("DELETE /api/env/:key — requires auth (401 without cookie)", async () => {
    const { default: app } = await import("../src/web/app.js");

    const res = await app.request("http://localhost/api/env/KEY", {
      method: "DELETE",
      headers: { Origin: "http://localhost" },
    });
    assert.equal(res.status, 401);
  });

  it("PUT /api/env/:key — non-admin user gets 403", async () => {
    await setupAuth();
    const user2 = await createUser("regular-shared-user", "pass");
    await approveUser(user2.id);
    const cookie2 = await createSession(user2.id);

    const { default: app } = await import("../src/web/app.js");

    const res = await app.request("http://localhost/api/env/KEY", {
      method: "PUT",
      headers: {
        Cookie: `volute_session=${cookie2}`,
        Origin: "http://localhost",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ value: "val" }),
    });
    assert.equal(res.status, 403);
    await deleteSession(cookie2);
  });
});
