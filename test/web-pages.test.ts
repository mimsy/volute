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

function setupTestDir() {
  testDir = resolve(tmpdir(), `volute-test-pages-${Date.now()}`);
  const pagesDir = resolve(testDir, "home", "pages");
  mkdirSync(pagesDir, { recursive: true });
  writeFileSync(resolve(pagesDir, "index.html"), "<h1>Hello</h1>");
  writeFileSync(resolve(pagesDir, "style.css"), "body { color: red; }");
  writeFileSync(resolve(pagesDir, "app.js"), "console.log('hi')");

  // Subdirectory with index.html
  const subDir = resolve(pagesDir, "about");
  mkdirSync(subDir, { recursive: true });
  writeFileSync(resolve(subDir, "index.html"), "<h1>About</h1>");

  // Secret file outside pages (in home/)
  writeFileSync(resolve(testDir, "home", "SOUL.md"), "secret soul");
  return testDir;
}

/**
 * Build a test app that mirrors the pages route but uses our test directory.
 * This avoids needing a real mind registry.
 */
function createApp(mindBaseDir: string) {
  const app = new Hono();

  app.get("/pages/:name/*", async (c) => {
    const name = c.req.param("name");

    // Simulate mind check — we only recognize "test-mind"
    if (name !== "test-mind") return c.text("Not found", 404);

    const pagesRoot = resolve(mindBaseDir, "home", "pages");
    const wildcard = c.req.path.replace(`/pages/${name}`, "") || "/";
    const requestedPath = resolve(pagesRoot, wildcard.slice(1));

    // Path traversal guard
    if (!requestedPath.startsWith(pagesRoot)) return c.text("Forbidden", 403);

    // Try exact file
    let fileStat = await stat(requestedPath).catch(() => null);

    // Directory → try index.html
    if (fileStat?.isDirectory()) {
      const indexPath = resolve(requestedPath, "index.html");
      fileStat = await stat(indexPath).catch(() => null);
      if (fileStat?.isFile()) {
        const body = await readFile(indexPath);
        return c.body(body, 200, { "Content-Type": "text/html" });
      }
      return c.text("Not found", 404);
    }

    if (fileStat?.isFile()) {
      const ext = extname(requestedPath);
      const mime = MIME_TYPES[ext] || "application/octet-stream";
      const body = await readFile(requestedPath);
      return c.body(body, 200, { "Content-Type": mime });
    }

    return c.text("Not found", 404);
  });

  return app;
}

describe("web pages routes", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("serves HTML files with correct MIME type", async () => {
    const dir = setupTestDir();
    const app = createApp(dir);

    const res = await app.request("/pages/test-mind/index.html");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/html");
    const body = await res.text();
    assert.ok(body.includes("<h1>Hello</h1>"));
  });

  it("serves CSS files with correct MIME type", async () => {
    const dir = setupTestDir();
    const app = createApp(dir);

    const res = await app.request("/pages/test-mind/style.css");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/css");
    const body = await res.text();
    assert.ok(body.includes("color: red"));
  });

  it("serves JS files with correct MIME type", async () => {
    const dir = setupTestDir();
    const app = createApp(dir);

    const res = await app.request("/pages/test-mind/app.js");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/javascript");
  });

  it("serves index.html for directory requests", async () => {
    const dir = setupTestDir();
    const app = createApp(dir);

    const res = await app.request("/pages/test-mind/about/");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/html");
    const body = await res.text();
    assert.ok(body.includes("<h1>About</h1>"));
  });

  it("serves index.html for root directory", async () => {
    const dir = setupTestDir();
    const app = createApp(dir);

    const res = await app.request("/pages/test-mind/");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/html");
    const body = await res.text();
    assert.ok(body.includes("<h1>Hello</h1>"));
  });

  it("blocks path traversal (URL normalization)", async () => {
    const dir = setupTestDir();
    const app = createApp(dir);

    // Hono normalizes `../` out of the URL before routing, so the request
    // either doesn't match the route or resolves to a non-existent file
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

    // Verify the resolve + startsWith guard works correctly
    const pagesRoot = resolve(dir, "home", "pages");
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

    // No Cookie header — should still work
    const res = await app.request("/pages/test-mind/index.html");
    assert.equal(res.status, 200);
  });
});
