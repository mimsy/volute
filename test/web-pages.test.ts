import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Hono } from "hono";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".txt": "text/plain",
};

let testDir: string;

function cleanup() {
  if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true });
}

/**
 * Set up a "snapshot" directory that simulates published content.
 * Everything in the snapshot dir is served — no manifest gating.
 */
function setupTestDir() {
  testDir = resolve(tmpdir(), `volute-test-pages-${Date.now()}`);

  // Snapshot dir (what gets served)
  const snapshotDir = resolve(testDir, "sites", "test-mind");
  mkdirSync(snapshotDir, { recursive: true });
  writeFileSync(resolve(snapshotDir, "index.html"), "<h1>Hello</h1>");
  writeFileSync(resolve(snapshotDir, "style.css"), "body { color: red; }");
  writeFileSync(resolve(snapshotDir, "app.js"), "console.log('hi')");

  // Subdirectory with index.html
  const subDir = resolve(snapshotDir, "about");
  mkdirSync(subDir, { recursive: true });
  writeFileSync(resolve(subDir, "index.html"), "<h1>About</h1>");

  // Source dir (working directory — NOT served)
  const sourceDir = resolve(testDir, "mind", "home", "pages");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(resolve(sourceDir, "draft.html"), "<h1>Draft</h1>");

  // Secret file outside pages (for path traversal tests)
  writeFileSync(resolve(testDir, "mind", "home", "SOUL.md"), "secret soul");

  return testDir;
}

/**
 * Build a test app that serves from the snapshot directory.
 * No manifest gating — everything in the snapshot is published.
 */
function createApp(baseDir: string) {
  const app = new Hono();

  app.get("/pages/:name/*", async (c) => {
    const name = c.req.param("name");

    // Simulate mind check — we only recognize "test-mind"
    if (name !== "test-mind") return c.text("Not found", 404);

    // Serve from snapshot dir (not source dir)
    const pagesRoot = resolve(baseDir, "sites", name);
    const wildcard = c.req.path.replace(`/pages/${name}`, "") || "/";
    const requestedPath = resolve(pagesRoot, wildcard.slice(1));

    // Path traversal guard
    if (!requestedPath.startsWith(pagesRoot)) return c.text("Forbidden", 403);

    // Determine file to serve
    let fileToServe = requestedPath;
    let fileStat = await stat(requestedPath).catch(() => null);

    if (fileStat?.isDirectory()) {
      const indexPath = resolve(requestedPath, "index.html");
      fileStat = await stat(indexPath).catch(() => null);
      if (fileStat?.isFile()) {
        fileToServe = indexPath;
      } else {
        return c.text("Not found", 404);
      }
    } else if (!fileStat?.isFile()) {
      return c.text("Not found", 404);
    }

    const ext = extname(fileToServe);
    const mime = MIME_TYPES[ext] || "application/octet-stream";
    const body = await readFile(fileToServe);
    return c.body(body, 200, { "Content-Type": mime });
  });

  return app;
}

describe("web pages routes", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("serves published HTML files with correct MIME type", async () => {
    const dir = setupTestDir();
    const app = createApp(dir);

    const res = await app.request("/pages/test-mind/index.html");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/html");
    const body = await res.text();
    assert.ok(body.includes("<h1>Hello</h1>"));
  });

  it("serves published CSS files with correct MIME type", async () => {
    const dir = setupTestDir();
    const app = createApp(dir);

    const res = await app.request("/pages/test-mind/style.css");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/css");
    const body = await res.text();
    assert.ok(body.includes("color: red"));
  });

  it("serves published JS files with correct MIME type", async () => {
    const dir = setupTestDir();
    const app = createApp(dir);

    const res = await app.request("/pages/test-mind/app.js");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/javascript");
  });

  it("serves index.html for published directory requests", async () => {
    const dir = setupTestDir();
    const app = createApp(dir);

    const res = await app.request("/pages/test-mind/about/");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/html");
    const body = await res.text();
    assert.ok(body.includes("<h1>About</h1>"));
  });

  it("serves index.html for published root directory", async () => {
    const dir = setupTestDir();
    const app = createApp(dir);

    const res = await app.request("/pages/test-mind/");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/html");
    const body = await res.text();
    assert.ok(body.includes("<h1>Hello</h1>"));
  });

  it("returns 404 for file not in snapshot", async () => {
    const dir = setupTestDir();
    const app = createApp(dir);

    // draft.html only exists in the source dir, not in the snapshot
    const res = await app.request("/pages/test-mind/draft.html");
    assert.equal(res.status, 404);
  });

  it("blocks path traversal (URL normalization)", async () => {
    const dir = setupTestDir();
    const app = createApp(dir);

    const res = await app.request("/pages/test-mind/../../../etc/passwd");
    assert.ok(res.status === 403 || res.status === 404);
  });

  it("blocks path traversal to parent home dir", async () => {
    const dir = setupTestDir();
    const app = createApp(dir);

    const res = await app.request("/pages/test-mind/../SOUL.md");
    assert.ok(res.status === 403 || res.status === 404);
  });

  it("resolve guard catches traversal paths", async () => {
    const dir = setupTestDir();

    const pagesRoot = resolve(dir, "sites", "test-mind");
    const attackPath = resolve(pagesRoot, "../../SOUL.md");
    assert.ok(!attackPath.startsWith(pagesRoot), "attack path should be outside pages root");
  });

  it("returns 404 for missing file", async () => {
    const dir = setupTestDir();
    const app = createApp(dir);

    const res = await app.request("/pages/test-mind/missing.html");
    assert.equal(res.status, 404);
  });

  it("returns 404 for unknown mind", async () => {
    const dir = setupTestDir();
    const app = createApp(dir);

    const res = await app.request("/pages/nonexistent/index.html");
    assert.equal(res.status, 404);
  });

  it("does not require authentication", async () => {
    const dir = setupTestDir();
    const app = createApp(dir);

    // No Cookie header — should still work for published files
    const res = await app.request("/pages/test-mind/index.html");
    assert.equal(res.status, 200);
  });

  it("blocks path traversal via name parameter", async () => {
    const dir = setupTestDir();
    const app = createApp(dir);

    // Traversal via name should return 404 (name check fails)
    const res = await app.request("/pages/../../etc/passwd");
    assert.ok(res.status === 403 || res.status === 404);
  });
});

describe("createPublicRoutes name traversal", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("blocks traversal in the :name parameter", async () => {
    const dir = setupTestDir();
    const { createPublicRoutes } = await import("../packages/extensions/pages/src/routes.js");

    const ctx = {
      dataDir: dir,
      db: null,
      authMiddleware: (() => {}) as any,
      getUser: async () => null,
      getUserByUsername: async () => null,
      getMindDir: () => null,
      getSystemsConfig: () => null,
      resolveUser: () => null,
      publishActivity: () => {},
      announceToSystem: async () => {},
      isIsolationEnabled: () => false,
      getMindUser: (name: string) => `mind-${name}`,
    };
    const publicApp = new Hono();
    publicApp.route("/public", createPublicRoutes(ctx));

    // Try traversal via the name segment
    const traversalNames = ["../../../etc", "..%2F..%2Fetc", "..", "."];
    for (const name of traversalNames) {
      const res = await publicApp.request(`/public/${name}/passwd`);
      assert.ok(
        res.status === 403 || res.status === 404,
        `Expected 403/404 for name="${name}", got ${res.status}`,
      );
    }
  });
});
