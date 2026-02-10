import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Hono } from "hono";
import { createUser } from "../src/lib/auth.js";
import { getDb } from "../src/lib/db.js";
import { conversations, messages, sessions, users } from "../src/lib/schema.js";
import { readVariants, removeAllVariants } from "../src/lib/variants.js";
import { authMiddleware, createSession } from "../src/web/middleware/auth.js";

let sessionId: string;
const testAgent = `web-variants-test-${Date.now()}`;

async function cleanup() {
  const db = await getDb();
  await db.delete(sessions);
  await db.delete(messages);
  await db.delete(conversations);
  await db.delete(users);
  removeAllVariants(testAgent);
}

async function setupAuth() {
  const user = await createUser("variants-admin", "pass");
  sessionId = await createSession(user.id);
  return sessionId;
}

// Build a test app that mirrors the variants route but uses agent name lookup
function createApp(agentExists: boolean) {
  const app = new Hono();
  app.use("/api/agents/*", authMiddleware);

  app.get("/api/agents/:name/variants", async (c) => {
    if (!agentExists) return c.json({ error: "Agent not found" }, 404);

    const variants = readVariants(testAgent);
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

  it("GET /:name/variants — 404 for missing agent", async () => {
    const cookie = await setupAuth();
    const app = createApp(false);

    const res = await app.request("/api/agents/nonexistent-agent/variants", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 404);
  });

  it("GET /:name/variants — lists variants for existing agent (empty)", async () => {
    const cookie = await setupAuth();
    const app = createApp(true);

    const res = await app.request("/api/agents/test-agent/variants", {
      headers: { Cookie: `volute_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
    assert.equal(body.length, 0);
  });

  it("GET /:name/variants — requires auth", async () => {
    const app = createApp(false);
    const res = await app.request("/api/agents/test-agent/variants");
    assert.equal(res.status, 401);
  });
});
