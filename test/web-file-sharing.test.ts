import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { like } from "drizzle-orm";
import { Hono } from "hono";
import { createUser } from "../packages/daemon/src/lib/auth.js";
import { listPending } from "../packages/daemon/src/lib/chat/file-sharing.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  addMind,
  mindDir,
  removeMind,
  stateDir,
} from "../packages/daemon/src/lib/mind/registry.js";
import { users } from "../packages/daemon/src/lib/schema.js";
import fileSharing from "../packages/daemon/src/web/api/file-sharing.js";
import { authMiddleware, createSession } from "../packages/daemon/src/web/middleware/auth.js";

let sessionId: string;

function createApp() {
  const app = new Hono();
  app.use("/api/v1/minds/*", authMiddleware);
  app.route("/api/v1/minds", fileSharing);
  return app;
}

async function cleanup() {
  const db = await getDb();
  await db.delete(users).where(like(users.username, "fs-admin-%"));
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

let currentUsername = "";

async function setupAuth(): Promise<string> {
  const user = await createUser(`fs-admin-${Date.now()}`, "pass");
  currentUsername = user.username;
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

  it("POST /:name/files/send — always stages file", async () => {
    const cookie = await setupAuth();
    setupMinds();
    const app = createApp();

    const res = await app.request("/api/v1/minds/fs-sender/files/send", {
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

  it("POST /:name/files/send — 404 for nonexistent sender", async () => {
    const cookie = await setupAuth();
    setupMinds();
    const app = createApp();

    const res = await app.request("/api/v1/minds/nonexistent/files/send", {
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

    const res = await app.request("/api/v1/minds/fs-sender/files/send", {
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

    const res = await app.request("/api/v1/minds/fs-sender/files/send", {
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

    const res = await app.request("/api/v1/minds/fs-sender/files/send", {
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
    await app.request("/api/v1/minds/fs-sender/files/send", {
      method: "POST",
      headers: reqHeaders(cookie),
      body: JSON.stringify({ targetMind: "fs-receiver", filePath: "notes.md" }),
    });

    const res = await app.request("/api/v1/minds/fs-receiver/files/pending", {
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
    const sendRes = await app.request("/api/v1/minds/fs-sender/files/send", {
      method: "POST",
      headers: reqHeaders(cookie),
      body: JSON.stringify({ targetMind: "fs-receiver", filePath: "notes.md" }),
    });
    const { id } = (await sendRes.json()) as { id: string };

    // Accept it
    const res = await app.request("/api/v1/minds/fs-receiver/files/accept", {
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

  it("POST /:name/files/accept — accepts with custom dest", async () => {
    const cookie = await setupAuth();
    setupMinds();
    const app = createApp();

    // Send a file
    const sendRes = await app.request("/api/v1/minds/fs-sender/files/send", {
      method: "POST",
      headers: reqHeaders(cookie),
      body: JSON.stringify({ targetMind: "fs-receiver", filePath: "notes.md" }),
    });
    const { id } = (await sendRes.json()) as { id: string };

    // Accept with custom dest
    const res = await app.request("/api/v1/minds/fs-receiver/files/accept", {
      method: "POST",
      headers: reqHeaders(cookie),
      body: JSON.stringify({ id, dest: "custom/incoming" }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; destPath: string };
    assert.ok(body.ok);
    assert.equal(body.destPath, "custom/incoming/fs-sender/notes.md");
  });

  it("POST /:name/files/reject — rejects pending file", async () => {
    const cookie = await setupAuth();
    setupMinds();
    const app = createApp();

    // Send a file
    const sendRes = await app.request("/api/v1/minds/fs-sender/files/send", {
      method: "POST",
      headers: reqHeaders(cookie),
      body: JSON.stringify({ targetMind: "fs-receiver", filePath: "notes.md" }),
    });
    const { id } = (await sendRes.json()) as { id: string };

    // Reject it
    const res = await app.request("/api/v1/minds/fs-receiver/files/reject", {
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

    const res = await app.request("/api/v1/minds/fs-receiver/files/accept", {
      method: "POST",
      headers: reqHeaders(cookie),
      body: JSON.stringify({ id: "nonexistent-id" }),
    });

    assert.equal(res.status, 404);
  });

  it("POST /:name/files/stage — stages file under the authenticated user", async () => {
    const cookie = await setupAuth();
    setupMinds();
    const app = createApp();

    const fileData = Buffer.from("test file content").toString("base64");
    const res = await app.request("/api/v1/minds/fs-receiver/files/stage", {
      method: "POST",
      headers: reqHeaders(cookie),
      // No `sender`: the caller cannot name its own volute identity, and the daemon
      // already knows it. Attribution comes from the session, not from the body.
      body: JSON.stringify({
        filename: "test.txt",
        data: fileData,
      }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; id: string };
    assert.equal(body.status, "pending");
    assert.ok(body.id);

    // Verify it's in pending, attributed to whoever actually staged it
    const pending = listPending("fs-receiver");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].sender, currentUsername);
    assert.equal(pending[0].filename, "test.txt");
  });

  // The offer is announced to the recipient as "[file] <sender> sent ...", so an
  // unguarded `sender` here misattributes a file exactly the way an unguarded
  // `sender` misattributed a message (#500).
  it("POST /:name/files/stage — refuses staging under someone else's name", async () => {
    const cookie = await setupAuth();
    setupMinds();
    const app = createApp();

    const res = await app.request("/api/v1/minds/fs-receiver/files/stage", {
      method: "POST",
      headers: reqHeaders(cookie),
      body: JSON.stringify({
        sender: "someone-else",
        filename: "test.txt",
        data: Buffer.from("x").toString("base64"),
      }),
    });

    assert.equal(res.status, 403);
    assert.equal(listPending("fs-receiver").length, 0, "a refused stage leaves nothing behind");
  });

  it("POST /:name/files/stage — 400 for missing fields", async () => {
    const cookie = await setupAuth();
    setupMinds();
    const app = createApp();

    const res = await app.request("/api/v1/minds/fs-receiver/files/stage", {
      method: "POST",
      headers: reqHeaders(cookie),
      body: JSON.stringify({ sender: "human-user" }), // missing filename and data
    });

    assert.equal(res.status, 400);
  });

  it("POST /:name/files/stage — 400 for path traversal in filename", async () => {
    const cookie = await setupAuth();
    setupMinds();
    const app = createApp();

    const fileData = Buffer.from("test").toString("base64");
    const res = await app.request("/api/v1/minds/fs-receiver/files/stage", {
      method: "POST",
      headers: reqHeaders(cookie),
      body: JSON.stringify({
        sender: "human-user",
        filename: "../evil.txt",
        data: fileData,
      }),
    });

    assert.equal(res.status, 400);
  });

  it("POST /:name/files/accept — 400 for path traversal in dest", async () => {
    const cookie = await setupAuth();
    setupMinds();
    const app = createApp();

    // Send a file first
    const sendRes = await app.request("/api/v1/minds/fs-sender/files/send", {
      method: "POST",
      headers: reqHeaders(cookie),
      body: JSON.stringify({ targetMind: "fs-receiver", filePath: "notes.md" }),
    });
    const { id } = (await sendRes.json()) as { id: string };

    // Accept with path traversal dest
    const res = await app.request("/api/v1/minds/fs-receiver/files/accept", {
      method: "POST",
      headers: reqHeaders(cookie),
      body: JSON.stringify({ id, dest: "../../etc" }),
    });

    assert.equal(res.status, 400);
  });

  it("requires auth — 401 without cookie", async () => {
    setupMinds();
    const app = createApp();

    const res = await app.request("/api/v1/minds/fs-receiver/files/pending");
    assert.equal(res.status, 401);
  });

  // The daemon reads the sender's file as root under user isolation, in a tree the sender
  // owns. Anything the sender plants to aim that read elsewhere — or to hang it — must be
  // refused, and nothing staged (#1272).
  describe("POST /:name/files/send — refuses what the sender planted", () => {
    let outside: string;
    beforeEach(() => {
      outside = mkdtempSync(join(tmpdir(), "fs-send-outside-"));
      writeFileSync(join(outside, "secrets.json"), "root-only secret");
    });
    afterEach(() => rmSync(outside, { recursive: true, force: true }));

    async function send(filePath: string) {
      const cookie = await setupAuth();
      const res = await createApp().request("/api/v1/minds/fs-sender/files/send", {
        method: "POST",
        headers: reqHeaders(cookie),
        body: JSON.stringify({ targetMind: "fs-receiver", filePath }),
      });
      return res;
    }

    it("a symlink at the name", async () => {
      setupMinds();
      symlinkSync(join(outside, "secrets.json"), resolve(mindDir("fs-sender"), "home", "x"));
      const res = await send("x");
      assert.equal(res.status, 400, await res.clone().text());
      assert.deepEqual(listPending("fs-receiver"), []);
    });

    it("a symlinked directory on the way", async () => {
      setupMinds();
      symlinkSync(outside, resolve(mindDir("fs-sender"), "home", "d"));
      const res = await send("d/secrets.json");
      assert.equal(res.status, 400, await res.clone().text());
      assert.deepEqual(listPending("fs-receiver"), []);
    });

    it("a hard link to a file elsewhere", async () => {
      setupMinds();
      linkSync(join(outside, "secrets.json"), resolve(mindDir("fs-sender"), "home", "x"));
      const res = await send("x");
      assert.equal(res.status, 400, await res.clone().text());
      assert.deepEqual(listPending("fs-receiver"), []);
    });

    it("a file over the 50MB cap, as 413", async () => {
      setupMinds();
      const big = resolve(mindDir("fs-sender"), "home", "big.bin");
      writeFileSync(big, "");
      truncateSync(big, 50 * 1024 * 1024 + 1);
      const res = await send("big.bin");
      assert.equal(res.status, 413, await res.clone().text());
      assert.match((await res.json()).error, /File too large \(50(\.0)? MB, max 50(\.0)? MB\)/);
      assert.deepEqual(listPending("fs-receiver"), []);
    });

    it("a path through a file, as 404", async () => {
      setupMinds();
      const res = await send("notes.md/x");
      assert.equal(res.status, 404, await res.clone().text());
    });

    it("an unreadable file is the daemon's error (500), not a refusal", async () => {
      setupMinds();
      const locked = resolve(mindDir("fs-sender"), "home", "locked.md");
      writeFileSync(locked, "locked");
      chmodSync(locked, 0o000);
      const res = await send("locked.md");
      assert.equal(res.status, 500, await res.clone().text());
      assert.deepEqual(listPending("fs-receiver"), []);
    });

    it("a FIFO, without blocking", async () => {
      setupMinds();
      execFileSync("mkfifo", [resolve(mindDir("fs-sender"), "home", "x")]);
      const res = await send("x");
      assert.equal(res.status, 400, await res.clone().text());
      assert.deepEqual(listPending("fs-receiver"), []);
    });
  });
});
