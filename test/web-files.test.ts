import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { createUser } from "../src/lib/auth.js";
import { getDb } from "../src/lib/db.js";
import { conversations, messages, users } from "../src/lib/schema.js";
import { authMiddleware, createSession, deleteSession } from "../src/web/middleware/auth.js";

let sessionId: string;
let testDir: string;

const ALLOWED_FILES = new Set([
  "SOUL.md",
  "MEMORY.md",
  "IDENTITY.md",
  "USER.md",
  "CLAUDE.md",
  "MOLT.md",
]);
const saveFileSchema = z.object({ content: z.string() });

async function cleanup() {
  const db = await getDb();
  await db.delete(messages);
  await db.delete(conversations);
  await db.delete(users);
  if (sessionId) deleteSession(sessionId);
  if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true });
}

async function setupAuth() {
  const user = await createUser("files-admin", "pass");
  sessionId = createSession(user.id);
  return sessionId;
}

function setupTestDir() {
  testDir = resolve(tmpdir(), `molt-test-files-${Date.now()}`);
  const homeDir = resolve(testDir, "home");
  mkdirSync(homeDir, { recursive: true });
  writeFileSync(resolve(homeDir, "SOUL.md"), "# Soul\nTest soul");
  writeFileSync(resolve(homeDir, "MEMORY.md"), "# Memory\nTest memory");
  writeFileSync(resolve(homeDir, "secret.txt"), "should not be accessible");
  return testDir;
}

// Build a test app that mirrors the files route but uses our test directory
function createApp(agentDir: string) {
  const app = new Hono();
  app.use("/api/agents/*", authMiddleware);

  app.get("/api/agents/:name/files", async (c) => {
    const homeDir = resolve(agentDir, "home");
    if (!existsSync(homeDir)) return c.json({ error: "Home directory missing" }, 404);
    const allFiles = await readdir(homeDir);
    const files = allFiles.filter((f) => f.endsWith(".md") && ALLOWED_FILES.has(f));
    return c.json(files);
  });

  app.get("/api/agents/:name/files/:filename", async (c) => {
    const filename = c.req.param("filename");
    if (!ALLOWED_FILES.has(filename)) return c.json({ error: "File not allowed" }, 403);
    const filePath = resolve(agentDir, "home", filename);
    if (!existsSync(filePath)) return c.json({ error: "File not found" }, 404);
    const content = await readFile(filePath, "utf-8");
    return c.json({ filename, content });
  });

  app.put("/api/agents/:name/files/:filename", zValidator("json", saveFileSchema), async (c) => {
    const filename = c.req.param("filename");
    if (!ALLOWED_FILES.has(filename)) return c.json({ error: "File not allowed" }, 403);
    const filePath = resolve(agentDir, "home", filename);
    const { content } = c.req.valid("json");
    await writeFile(filePath, content);
    return c.json({ ok: true });
  });

  return app;
}

describe("web files routes", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("GET /:name/files — lists allowed markdown files", async () => {
    const cookie = await setupAuth();
    const dir = setupTestDir();
    const app = createApp(dir);

    const res = await app.request("/api/agents/test-agent/files", {
      headers: { Cookie: `molt_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
    assert.ok(body.includes("SOUL.md"));
    assert.ok(body.includes("MEMORY.md"));
    assert.ok(!body.includes("secret.txt"));
  });

  it("GET /:name/files/:filename — reads file content", async () => {
    const cookie = await setupAuth();
    const dir = setupTestDir();
    const app = createApp(dir);

    const res = await app.request("/api/agents/test-agent/files/SOUL.md", {
      headers: { Cookie: `molt_session=${cookie}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.filename, "SOUL.md");
    assert.ok(body.content.includes("Test soul"));
  });

  it("GET /:name/files/:filename — 403 for disallowed file", async () => {
    const cookie = await setupAuth();
    const dir = setupTestDir();
    const app = createApp(dir);

    const res = await app.request("/api/agents/test-agent/files/secret.txt", {
      headers: { Cookie: `molt_session=${cookie}` },
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.ok(body.error.includes("not allowed"));
  });

  it("PUT /:name/files/:filename — writes file", async () => {
    const cookie = await setupAuth();
    const dir = setupTestDir();
    const app = createApp(dir);

    const res = await app.request("/api/agents/test-agent/files/SOUL.md", {
      method: "PUT",
      headers: {
        Cookie: `molt_session=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: "# Updated Soul\nNew content" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.ok);

    const content = readFileSync(resolve(dir, "home", "SOUL.md"), "utf-8");
    assert.ok(content.includes("New content"));
  });

  it("PUT /:name/files/:filename — 403 for disallowed file", async () => {
    const cookie = await setupAuth();
    const dir = setupTestDir();
    const app = createApp(dir);

    const res = await app.request("/api/agents/test-agent/files/secret.txt", {
      method: "PUT",
      headers: {
        Cookie: `molt_session=${cookie}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: "hacked" }),
    });
    assert.equal(res.status, 403);
  });
});
