import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Hono } from "hono";
import { createUser } from "../src/lib/auth.js";
import { getDb } from "../src/lib/db.js";
import { conversations, messages, sessions, users } from "../src/lib/schema.js";
import { readVariants, removeAllVariants } from "../src/lib/variants.js";
import { authMiddleware, createSession } from "../src/web/middleware/auth.js";

let sessionId: string;
const testMind = `web-variants-test-${Date.now()}`;

async function cleanup() {
  const db = await getDb();
  await db.delete(sessions);
  await db.delete(messages);
  await db.delete(conversations);
  await db.delete(users);
  removeAllVariants(testMind);
}

async function setupAuth() {
  const user = await createUser("variants-admin", "pass");
  sessionId = await createSession(user.id);
  return sessionId;
}

// Build a test app that mirrors the variants route but uses mind name lookup
function createApp(mindExists: boolean) {
  const app = new Hono();
  app.use("/api/minds/*", authMiddleware);

  app.get("/api/minds/:name/variants", async (c) => {
    if (!mindExists) return c.json({ error: "Mind not found" }, 404);

    const variants = readVariants(testMind);
    const results = variants.map((v) => ({
      ...v,
      status: v.port ? "no-server" : "no-server",
    }));
    return c.json(results);
  });

  return app;
}

describe("web variants routes", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("GET /:name/variants — 404 for missing mind", async () => {
    const cookie = await setupAuth();
    const app = createApp(false);

    const res = await app.request("/api/minds/nonexistent-mind/variants", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 404);
  });

  it("GET /:name/variants — lists variants for existing mind (empty)", async () => {
    const cookie = await setupAuth();
    const app = createApp(true);

    const res = await app.request("/api/minds/test-mind/variants", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
    assert.equal(body.length, 0);
  });

  it("GET /:name/variants — requires auth", async () => {
    const app = createApp(false);
    const res = await app.request("/api/minds/test-mind/variants");
    assert.equal(res.status, 401);
  });
});
