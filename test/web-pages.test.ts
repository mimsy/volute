import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Hono } from "hono";
import { parseFrontmatter, resolveStylesheet } from "../packages/extensions/pages/src/markdown.js";

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

  // Markdown files
  writeFileSync(
    resolve(snapshotDir, "hello.md"),
    "---\ntitle: Hello World\n---\n\n# Hello\n\nThis is **bold**.\n",
  );
  writeFileSync(resolve(snapshotDir, "plain.md"), "# No frontmatter\n\nJust content.\n");

  // Subdirectory with index.md (no index.html)
  const blogDir = resolve(snapshotDir, "blog");
  mkdirSync(blogDir, { recursive: true });
  writeFileSync(resolve(blogDir, "index.md"), "# Blog\n\nWelcome to the blog.\n");
  writeFileSync(resolve(blogDir, "style.css"), "body { color: blue; }");

  // Subdirectory with both index.html and index.md (html should win)
  const bothDir = resolve(snapshotDir, "both");
  mkdirSync(bothDir, { recursive: true });
  writeFileSync(resolve(bothDir, "index.html"), "<h1>HTML wins</h1>");
  writeFileSync(resolve(bothDir, "index.md"), "# MD loses\n");

  // Markdown with frontmatter style override
  writeFileSync(
    resolve(snapshotDir, "styled.md"),
    "---\ntitle: Styled\nstyle: blog/style.css\n---\n\n# Styled page\n",
  );

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

function makeCtx(dir: string) {
  return {
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
}

describe("createPublicRoutes name traversal", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("blocks traversal in the :name parameter", async () => {
    const dir = setupTestDir();
    const { createPublicRoutes } = await import("../packages/extensions/pages/src/routes.js");

    const publicApp = new Hono();
    publicApp.route("/public", createPublicRoutes(makeCtx(dir)));

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

describe("markdown page rendering", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("serves .md files as rendered HTML", async () => {
    const dir = setupTestDir();
    const { createPublicRoutes } = await import("../packages/extensions/pages/src/routes.js");
    const publicApp = new Hono();
    publicApp.route("/public", createPublicRoutes(makeCtx(dir)));

    const res = await publicApp.request("/public/test-mind/hello.md");
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("content-type")?.includes("text/html"));
    const body = await res.text();
    assert.ok(body.includes("<strong>bold</strong>"), "should render markdown");
    assert.ok(body.includes("<title>Hello World</title>"), "should use frontmatter title");
    assert.ok(body.includes("<!DOCTYPE html>"), "should be a full HTML document");
  });

  it("renders .md without frontmatter", async () => {
    const dir = setupTestDir();
    const { createPublicRoutes } = await import("../packages/extensions/pages/src/routes.js");
    const publicApp = new Hono();
    publicApp.route("/public", createPublicRoutes(makeCtx(dir)));

    const res = await publicApp.request("/public/test-mind/plain.md");
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes("<title>Untitled</title>"), "should default to Untitled");
    assert.ok(body.includes("Just content."), "should render body");
  });

  it("auto-includes style.css from same directory", async () => {
    const dir = setupTestDir();
    const { createPublicRoutes } = await import("../packages/extensions/pages/src/routes.js");
    const publicApp = new Hono();
    publicApp.route("/public", createPublicRoutes(makeCtx(dir)));

    const res = await publicApp.request("/public/test-mind/blog/index.md");
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(
      body.includes('href="/ext/pages/public/test-mind/blog/style.css"'),
      "should link to local style.css",
    );
  });

  it("falls back to root style.css", async () => {
    const dir = setupTestDir();
    const { createPublicRoutes } = await import("../packages/extensions/pages/src/routes.js");
    const publicApp = new Hono();
    publicApp.route("/public", createPublicRoutes(makeCtx(dir)));

    // plain.md is at the root level where style.css exists
    const res = await publicApp.request("/public/test-mind/plain.md");
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(
      body.includes('href="/ext/pages/public/test-mind/style.css"'),
      "should link to root style.css",
    );
  });

  it("uses frontmatter style override", async () => {
    const dir = setupTestDir();
    const { createPublicRoutes } = await import("../packages/extensions/pages/src/routes.js");
    const publicApp = new Hono();
    publicApp.route("/public", createPublicRoutes(makeCtx(dir)));

    const res = await publicApp.request("/public/test-mind/styled.md");
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(
      body.includes('href="/ext/pages/public/test-mind/blog/style.css"'),
      "should link to frontmatter-specified style",
    );
  });

  it("serves index.md as directory index fallback", async () => {
    const dir = setupTestDir();
    const { createPublicRoutes } = await import("../packages/extensions/pages/src/routes.js");
    const publicApp = new Hono();
    publicApp.route("/public", createPublicRoutes(makeCtx(dir)));

    const res = await publicApp.request("/public/test-mind/blog/");
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("content-type")?.includes("text/html"));
    const body = await res.text();
    assert.ok(body.includes("Welcome to the blog"), "should render index.md content");
  });

  it("prefers index.html over index.md", async () => {
    const dir = setupTestDir();
    const { createPublicRoutes } = await import("../packages/extensions/pages/src/routes.js");
    const publicApp = new Hono();
    publicApp.route("/public", createPublicRoutes(makeCtx(dir)));

    const res = await publicApp.request("/public/test-mind/both/");
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes("HTML wins"), "should serve index.html, not index.md");
  });
});

describe("parseFrontmatter", () => {
  it("parses title and style", () => {
    const result = parseFrontmatter("---\ntitle: My Title\nstyle: custom.css\n---\n\n# Body\n");
    assert.equal(result.title, "My Title");
    assert.equal(result.style, "custom.css");
    assert.ok(result.body.includes("# Body"));
  });

  it("returns body as-is when no frontmatter", () => {
    const result = parseFrontmatter("# Just content\n\nHello.\n");
    assert.equal(result.title, undefined);
    assert.equal(result.style, undefined);
    assert.equal(result.body, "# Just content\n\nHello.\n");
  });

  it("handles partial frontmatter", () => {
    const result = parseFrontmatter("---\ntitle: Only Title\n---\n\nContent.\n");
    assert.equal(result.title, "Only Title");
    assert.equal(result.style, undefined);
  });
});

describe("XSS prevention", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("escapes HTML in frontmatter title", async () => {
    const dir = resolve(tmpdir(), `volute-test-xss-${Date.now()}`);
    const sitesDir = resolve(dir, "sites", "test-mind");
    mkdirSync(sitesDir, { recursive: true });
    testDir = dir;
    writeFileSync(
      resolve(sitesDir, "xss.md"),
      "---\ntitle: </title><script>alert(1)</script>\n---\n\n# Safe\n",
    );

    const { createPublicRoutes } = await import("../packages/extensions/pages/src/routes.js");
    const publicApp = new Hono();
    publicApp.route("/public", createPublicRoutes(makeCtx(dir)));

    const res = await publicApp.request("/public/test-mind/xss.md");
    const body = await res.text();
    assert.ok(!body.includes("<script>"), "should not contain unescaped script tag");
    assert.ok(body.includes("&lt;script&gt;"), "should escape HTML entities in title");
  });
});

describe("resolveStylesheet", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("returns null when no stylesheet exists", () => {
    const dir = resolve(tmpdir(), `volute-test-css-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    testDir = dir;
    writeFileSync(resolve(dir, "page.md"), "# Test");
    const result = resolveStylesheet(resolve(dir, "page.md"), dir);
    assert.equal(result, null);
  });

  it("finds style.css in same directory", () => {
    const dir = resolve(tmpdir(), `volute-test-css-${Date.now()}`);
    const sub = resolve(dir, "sub");
    mkdirSync(sub, { recursive: true });
    testDir = dir;
    writeFileSync(resolve(sub, "style.css"), "body {}");
    const result = resolveStylesheet(resolve(sub, "page.md"), dir);
    assert.equal(result, "sub/style.css");
  });

  it("falls back to root style.css", () => {
    const dir = resolve(tmpdir(), `volute-test-css-${Date.now()}`);
    const sub = resolve(dir, "sub");
    mkdirSync(sub, { recursive: true });
    testDir = dir;
    writeFileSync(resolve(dir, "style.css"), "body {}");
    const result = resolveStylesheet(resolve(sub, "page.md"), dir);
    assert.equal(result, "style.css");
  });

  it("uses frontmatter style when file exists", () => {
    const dir = resolve(tmpdir(), `volute-test-css-${Date.now()}`);
    mkdirSync(resolve(dir, "css"), { recursive: true });
    testDir = dir;
    writeFileSync(resolve(dir, "css/dark.css"), "body {}");
    writeFileSync(resolve(dir, "style.css"), "body {}");
    const result = resolveStylesheet(resolve(dir, "page.md"), dir, "css/dark.css");
    assert.equal(result, "css/dark.css");
  });

  it("rejects path traversal in frontmatter style", () => {
    const dir = resolve(tmpdir(), `volute-test-css-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    testDir = dir;
    // Even if the target exists, traversal should be blocked
    const result = resolveStylesheet(resolve(dir, "page.md"), dir, "../../../etc/passwd");
    assert.equal(result, null);
  });
});
