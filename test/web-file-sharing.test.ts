import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Hono } from "hono";
import { createUser } from "../src/lib/auth.js";
import { getDb } from "../src/lib/db.js";
import {
  listPending,
  readFileSharingConfig,
  writeFileSharingConfig,
} from "../src/lib/file-sharing.js";
import { addMind, mindDir, removeMind, stateDir } from "../src/lib/registry.js";
import { sessions, users } from "../src/lib/schema.js";
import fileSharing from "../src/web/api/file-sharing.js";
import { authMiddleware, createSession } from "../src/web/middleware/auth.js";

let sessionId: string;

function createApp() {
  const app = new Hono();
  app.use("/api/minds/*", authMiddleware);
  app.route("/api/minds", fileSharing);
  return app;
}

async function cleanup() {
  const db = await getDb();
  await db.delete(sessions);
  await db.delete(users);
  // Clean up test mind dirs
  for (const name of ["fs-sender", "fs-receiver"]) {
    const dir = mindDir(name);
    if (existsSync(dir)) rmSync(dir, { recursive: true });
    const state = stateDir(name);
    if (existsSync(state)) rmSync(state, { recursive: true });
    try {
      removeMind(name);
    } catch {
      // ignore
    }
  }
}

async function setupAuth(): Promise<string> {
  const user = await createUser(`fs-admin-${Date.now()}`, "pass");
  sessionId = await createSession(user.id);
  return sessionId;
}

function setupMinds() {
  // Create sender mind with a file
  addMind("fs-sender", 14100);
  const senderHome = resolve(mindDir("fs-sender"), "home");
  mkdirSync(senderHome, { recursive: true });
  writeFileSync(resolve(senderHome, "notes.md"), "# Notes\nHello from sender");
  mkdirSync(stateDir("fs-sender"), { recursive: true });

  // Create receiver mind
  addMind("fs-receiver", 14101);
  const receiverHome = resolve(mindDir("fs-receiver"), "home", ".config");
  mkdirSync(receiverHome, { recursive: true });
  mkdirSync(stateDir("fs-receiver"), { recursive: true });
}

function reqHeaders(cookie: string, json = true) {
  const h: Record<string, string> = {
    Cookie: `volute_session=${cookie}`,
    Origin: "http://localhost",
  };
  if (json) h["Content-Type"] = "application/json";
  return h;
}

describe("web file-sharing routes", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("POST /:name/files/send — stages file for untrusted sender", async () => {
    const cookie = await setupAuth();
    setupMinds();
    const app = createApp();

    const res = await app.request("/api/minds/fs-sender/files/send", {
      method: "POST",
      headers: reqHeaders(cookie),
      body: JSON.stringify({ targetMind: "fs-receiver", filePath: "notes.md" }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; id: string };
    assert.equal(body.status, "pending");
    assert.ok(body.id);

    // Verify it's in pending
    const pending = listPending("fs-receiver");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].sender, "fs-sender");
    assert.equal(pending[0].filename, "notes.md");
  });

  it("POST /:name/files/send — delivers directly for trusted sender", async () => {
    const cookie = await setupAuth();
    setupMinds();
    writeFileSharingConfig(mindDir("fs-receiver"), { trustedSenders: ["fs-sender"] });
    const app = createApp();

    const res = await app.request("/api/minds/fs-sender/files/send", {
      method: "POST",
      headers: reqHeaders(cookie),
      body: JSON.stringify({ targetMind: "fs-receiver", filePath: "notes.md" }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; destPath: string };
    assert.equal(body.status, "delivered");
    assert.equal(body.destPath, "inbox/fs-sender/notes.md");

    // File should exist in receiver's inbox
    const deliveredPath = resolve(mindDir("fs-receiver"), "home", "inbox", "fs-sender", "notes.md");
    assert.ok(existsSync(deliveredPath));
    assert.equal(readFileSync(deliveredPath, "utf-8"), "# Notes\nHello from sender");
  });

  it("POST /:name/files/send — 404 for nonexistent sender", async () => {
    const cookie = await setupAuth();
    setupMinds();
    const app = createApp();

    const res = await app.request("/api/minds/nonexistent/files/send", {
      method: "POST",
      headers: reqHeaders(cookie),
      body: JSON.stringify({ targetMind: "fs-receiver", filePath: "notes.md" }),
    });

    assert.equal(res.status, 404);
  });

  it("POST /:name/files/send — 404 for nonexistent target mind", async () => {
    const cookie = await setupAuth();
    setupMinds();
    const app = createApp();

    const res = await app.request("/api/minds/fs-sender/files/send", {
      method: "POST",
      headers: reqHeaders(cookie),
      body: JSON.stringify({ targetMind: "nonexistent", filePath: "notes.md" }),
    });

    assert.equal(res.status, 404);
  });

  it("POST /:name/files/send — 400 for path traversal", async () => {
    const cookie = await setupAuth();
    setupMinds();
    const app = createApp();

    const res = await app.request("/api/minds/fs-sender/files/send", {
      method: "POST",
      headers: reqHeaders(cookie),
      body: JSON.stringify({ targetMind: "fs-receiver", filePath: "../etc/passwd" }),
    });

    assert.equal(res.status, 400);
  });

  it("POST /:name/files/send — 404 for missing file", async () => {
    const cookie = await setupAuth();
    setupMinds();
    const app = createApp();

    const res = await app.request("/api/minds/fs-sender/files/send", {
      method: "POST",
      headers: reqHeaders(cookie),
      body: JSON.stringify({ targetMind: "fs-receiver", filePath: "nonexistent.txt" }),
    });

    assert.equal(res.status, 404);
  });

  it("GET /:name/files/pending — lists pending files", async () => {
    const cookie = await setupAuth();
    setupMinds();
    const app = createApp();

    // Send a file first to create a pending entry
    await app.request("/api/minds/fs-sender/files/send", {
      method: "POST",
      headers: reqHeaders(cookie),
      body: JSON.stringify({ targetMind: "fs-receiver", filePath: "notes.md" }),
    });

    const res = await app.request("/api/minds/fs-receiver/files/pending", {
      headers: reqHeaders(cookie, false),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{ sender: string; filename: string }>;
    assert.equal(body.length, 1);
    assert.equal(body[0].sender, "fs-sender");
  });

  it("POST /:name/files/accept — accepts pending file", async () => {
    const cookie = await setupAuth();
    setupMinds();
    const app = createApp();

    // Send a file
    const sendRes = await app.request("/api/minds/fs-sender/files/send", {
      method: "POST",
      headers: reqHeaders(cookie),
      body: JSON.stringify({ targetMind: "fs-receiver", filePath: "notes.md" }),
    });
    const { id } = (await sendRes.json()) as { id: string };

    // Accept it
    const res = await app.request("/api/minds/fs-receiver/files/accept", {
      method: "POST",
      headers: reqHeaders(cookie),
      body: JSON.stringify({ id }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; destPath: string };
    assert.ok(body.ok);
    assert.equal(body.destPath, "inbox/fs-sender/notes.md");

    // File should be in receiver's inbox
    const deliveredPath = resolve(mindDir("fs-receiver"), "home", "inbox", "fs-sender", "notes.md");
    assert.ok(existsSync(deliveredPath));

    // Pending should be empty
    assert.equal(listPending("fs-receiver").length, 0);
  });

  it("POST /:name/files/reject — rejects pending file", async () => {
    const cookie = await setupAuth();
    setupMinds();
    const app = createApp();

    // Send a file
    const sendRes = await app.request("/api/minds/fs-sender/files/send", {
      method: "POST",
      headers: reqHeaders(cookie),
      body: JSON.stringify({ targetMind: "fs-receiver", filePath: "notes.md" }),
    });
    const { id } = (await sendRes.json()) as { id: string };

    // Reject it
    const res = await app.request("/api/minds/fs-receiver/files/reject", {
      method: "POST",
      headers: reqHeaders(cookie),
      body: JSON.stringify({ id }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.ok(body.ok);

    // Pending should be empty
    assert.equal(listPending("fs-receiver").length, 0);
  });

  it("POST /:name/files/accept — 404 for nonexistent id", async () => {
    const cookie = await setupAuth();
    setupMinds();
    const app = createApp();

    const res = await app.request("/api/minds/fs-receiver/files/accept", {
      method: "POST",
      headers: reqHeaders(cookie),
      body: JSON.stringify({ id: "nonexistent-id" }),
    });

    assert.equal(res.status, 404);
  });

  it("POST /:name/files/trust — adds trusted sender", async () => {
    const cookie = await setupAuth();
    setupMinds();
    const app = createApp();

    const res = await app.request("/api/minds/fs-receiver/files/trust", {
      method: "POST",
      headers: reqHeaders(cookie),
      body: JSON.stringify({ sender: "fs-sender" }),
    });

    assert.equal(res.status, 200);
    const config = readFileSharingConfig(mindDir("fs-receiver"));
    assert.ok(config.trustedSenders?.includes("fs-sender"));
  });

  it("DELETE /:name/files/trust/:sender — removes trusted sender", async () => {
    const cookie = await setupAuth();
    setupMinds();
    writeFileSharingConfig(mindDir("fs-receiver"), { trustedSenders: ["fs-sender"] });
    const app = createApp();

    const res = await app.request("/api/minds/fs-receiver/files/trust/fs-sender", {
      method: "DELETE",
      headers: reqHeaders(cookie, false),
    });

    assert.equal(res.status, 200);
    const config = readFileSharingConfig(mindDir("fs-receiver"));
    assert.ok(!config.trustedSenders?.includes("fs-sender"));
  });

  it("requires auth — 401 without cookie", async () => {
    setupMinds();
    const app = createApp();

    const res = await app.request("/api/minds/fs-receiver/files/pending");
    assert.equal(res.status, 401);
  });
});
