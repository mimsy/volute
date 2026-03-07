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
  ".txt": "text/plain",
  ".md": "text/markdown",
};

let testDir: string;

function cleanup() {
  if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true });
}

function setupTestDir() {
  testDir = resolve(tmpdir(), `volute-test-public-${Date.now()}`);
  const publicDir = resolve(testDir, "home", "public");
  mkdirSync(publicDir, { recursive: true });
  writeFileSync(resolve(publicDir, "readme.txt"), "hello world");
  writeFileSync(resolve(publicDir, "data.json"), '{"key":"value"}');

  // Subdirectory
  const subDir = resolve(publicDir, "docs");
  mkdirSync(subDir, { recursive: true });
  writeFileSync(resolve(subDir, "guide.md"), "# Guide");

  // Pages subdirectory
  const pagesDir = resolve(publicDir, "pages");
  mkdirSync(pagesDir, { recursive: true });
  writeFileSync(resolve(pagesDir, "index.html"), "<h1>Page</h1>");

  // Secret file outside public (in home/)
  writeFileSync(resolve(testDir, "home", "SOUL.md"), "secret soul");

  // Shared directory (for _system)
  const sharedDir = resolve(testDir, "shared");
  mkdirSync(sharedDir, { recursive: true });
  const sharedPagesDir = resolve(sharedDir, "pages");
  mkdirSync(sharedPagesDir, { recursive: true });
  writeFileSync(resolve(sharedPagesDir, "index.html"), "<h1>System</h1>");
  writeFileSync(resolve(sharedDir, "info.txt"), "shared info");

  return testDir;
}

function createApp(mindBaseDir: string) {
  const app = new Hono();

  function resolveRoot(name: string): string | null {
    if (name === "_system") return resolve(mindBaseDir, "shared");
    if (name === "test-mind") return resolve(mindBaseDir, "home", "public");
    return null;
  }

  // Directory listing
  app.get("/public/:name/", async (c) => {
    const name = c.req.param("name");
    const publicRoot = resolveRoot(name);
    if (!publicRoot) return c.json({ error: "Not found" }, 404);

    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(publicRoot, { withFileTypes: true }).catch(() => []);

    const items = entries
      .filter((e) => !e.name.startsWith("."))
      .map((e) => ({
        name: e.name,
        type: e.isDirectory() ? "directory" : "file",
      }));

    return c.json(items);
  });

  // File serving
  app.get("/public/:name/*", async (c) => {
    const name = c.req.param("name");
    const publicRoot = resolveRoot(name);
    if (!publicRoot) return c.text("Not found", 404);
    const wildcard = c.req.path.replace(`/public/${name}`, "") || "/";
    const requestedPath = resolve(publicRoot, wildcard.slice(1));

    if (!requestedPath.startsWith(publicRoot)) return c.text("Forbidden", 403);

    const fileStat = await stat(requestedPath).catch(() => null);

    if (fileStat?.isDirectory()) {
      if (wildcard.endsWith("/")) {
        const { readdir: rd } = await import("node:fs/promises");
        const dirEntries = await rd(requestedPath, { withFileTypes: true }).catch(() => []);
        const items = dirEntries
          .filter((e) => !e.name.startsWith("."))
          .map((e) => ({
            name: e.name,
            type: e.isDirectory() ? "directory" : "file",
          }));
        return c.json(items);
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

describe("public files routes", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("serves files with correct MIME type", async () => {
    const dir = setupTestDir();
    const app = createApp(dir);

    const res = await app.request("/public/test-mind/readme.txt");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/plain");
    const body = await res.text();
    assert.equal(body, "hello world");
  });

  it("serves JSON files", async () => {
    const dir = setupTestDir();
    const app = createApp(dir);

    const res = await app.request("/public/test-mind/data.json");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/json");
  });

  it("serves files in subdirectories", async () => {
    const dir = setupTestDir();
    const app = createApp(dir);

    const res = await app.request("/public/test-mind/docs/guide.md");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/markdown");
    const body = await res.text();
    assert.ok(body.includes("# Guide"));
  });

  it("serves pages files through public path", async () => {
    const dir = setupTestDir();
    const app = createApp(dir);

    const res = await app.request("/public/test-mind/pages/index.html");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/html");
  });

  it("returns directory listing for subdirectory with trailing slash", async () => {
    const dir = setupTestDir();
    const app = createApp(dir);

    const res = await app.request("/public/test-mind/docs/");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
    const names = body.map((e: { name: string }) => e.name);
    assert.ok(names.includes("guide.md"));
  });

  it("returns 404 for directory without trailing slash", async () => {
    const dir = setupTestDir();
    const app = createApp(dir);

    const res = await app.request("/public/test-mind/docs");
    assert.equal(res.status, 404);
  });

  it("blocks path traversal", async () => {
    const dir = setupTestDir();
    const app = createApp(dir);

    const res = await app.request("/public/test-mind/../../../etc/passwd");
    assert.ok(res.status === 403 || res.status === 404);
  });

  it("blocks path traversal to home dir", async () => {
    const dir = setupTestDir();
    const app = createApp(dir);

    const res = await app.request("/public/test-mind/../SOUL.md");
    assert.ok(res.status === 403 || res.status === 404);
  });

  it("returns 404 for missing file", async () => {
    const dir = setupTestDir();
    const app = createApp(dir);

    const res = await app.request("/public/test-mind/nonexistent.txt");
    assert.equal(res.status, 404);
  });

  it("returns 404 for unknown mind", async () => {
    const dir = setupTestDir();
    const app = createApp(dir);

    const res = await app.request("/public/nonexistent/readme.txt");
    assert.equal(res.status, 404);
  });

  it("does not require authentication", async () => {
    const dir = setupTestDir();
    const app = createApp(dir);

    const res = await app.request("/public/test-mind/readme.txt");
    assert.equal(res.status, 200);
  });

  it("returns directory listing for root", async () => {
    const dir = setupTestDir();
    const app = createApp(dir);

    const res = await app.request("/public/test-mind/");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
    const names = body.map((e: { name: string }) => e.name);
    assert.ok(names.includes("readme.txt"));
    assert.ok(names.includes("data.json"));
    assert.ok(names.includes("docs"));
    assert.ok(names.includes("pages"));

    const docsEntry = body.find((e: { name: string }) => e.name === "docs");
    assert.equal(docsEntry.type, "directory");
    const readmeEntry = body.find((e: { name: string }) => e.name === "readme.txt");
    assert.equal(readmeEntry.type, "file");
  });

  it("serves _system shared files", async () => {
    const dir = setupTestDir();
    const app = createApp(dir);

    const res = await app.request("/public/_system/info.txt");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/plain");
    const body = await res.text();
    assert.equal(body, "shared info");
  });

  it("lists _system shared directory", async () => {
    const dir = setupTestDir();
    const app = createApp(dir);

    const res = await app.request("/public/_system/");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body));
    const names = body.map((e: { name: string }) => e.name);
    assert.ok(names.includes("pages"));
    assert.ok(names.includes("info.txt"));
  });

  it("serves _system shared subdirectory files", async () => {
    const dir = setupTestDir();
    const app = createApp(dir);

    const res = await app.request("/public/_system/pages/index.html");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/html");
    const body = await res.text();
    assert.ok(body.includes("<h1>System</h1>"));
  });
});
