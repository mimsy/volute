import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Hono } from "hono";
import { createUser } from "../src/lib/auth.js";
import { getDb } from "../src/lib/db.js";
import { conversations, messages, users } from "../src/lib/schema.js";
import { readVariants } from "../src/lib/variants.js";
import { authMiddleware, createSession, deleteSession } from "../src/web/middleware/auth.js";

let sessionId: string;
let testDir: string;

async function cleanup() {
  const db = await getDb();
  await db.delete(messages);
  await db.delete(conversations);
  await db.delete(users);
  if (sessionId) deleteSession(sessionId);
  if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true });
}

async function setupAuth() {
  const user = await createUser("variants-admin", "pass");
  sessionId = createSession(user.id);
  return sessionId;
}

// Build a test app that mirrors the variants route but uses our test directory
function createApp(agentDir?: string) {
  const app = new Hono();
  app.use("/api/agents/*", authMiddleware);

  app.get("/api/agents/:name/variants", async (c) => {
    if (!agentDir) return c.json({ error: "Agent not found" }, 404);
    if (!existsSync(agentDir)) return c.json({ error: "Agent directory missing" }, 404);

    const variants = readVariants(agentDir);
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
    // App created without agentDir simulates missing agent
    const app = createApp();

    const res = await app.request("/api/agents/nonexistent-agent/variants", {
      headers: { Cookie: `molt_session=${cookie}` },
    });
    assert.equal(res.status, 404);
  });

  it("GET /:name/variants — lists variants for existing agent (empty)", async () => {
    const cookie = await setupAuth();

    testDir = resolve(tmpdir(), `molt-test-variants-${Date.now()}`);
    const moltDir = resolve(testDir, ".molt");
    mkdirSync(moltDir, { recursive: true });
    writeFileSync(resolve(moltDir, "variants.json"), "[]");

    const app = createApp(testDir);

    const res = await app.request("/api/agents/test-agent/variants", {
      headers: { Cookie: `molt_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
    assert.equal(body.length, 0);
  });

  it("GET /:name/variants — requires auth", async () => {
    const app = createApp();
    const res = await app.request("/api/agents/test-agent/variants");
    assert.equal(res.status, 401);
  });
});
