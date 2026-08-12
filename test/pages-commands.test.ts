import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { approveUser, createUser } from "../packages/daemon/src/lib/auth.js";
import {
  deleteSystemsConfig,
  readSystemsConfig,
  writeSystemsConfig,
} from "../packages/daemon/src/lib/config/systems-config.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { loadAllExtensions } from "../packages/daemon/src/lib/extensions.js";
import { addMind, removeMind, voluteSystemDir } from "../packages/daemon/src/lib/mind/registry.js";
import { users } from "../packages/daemon/src/lib/schema.js";
import { authMiddleware, createSession } from "../packages/daemon/src/web/middleware/auth.js";

function configPath() {
  return resolve(voluteSystemDir(), "systems.json");
}

// ---------------------------------------------------------------------------
// db unit tests
// ---------------------------------------------------------------------------

import {
  getAllSites,
  getPublishedPages,
  getRecentPages,
  getSystemPages,
  initDb,
  syncPublishedPages,
  syncSystemPages,
} from "../packages/extensions/pages/src/db.js";
import type { Database } from "../packages/extensions/sdk/src/types.js";

/** Build page inputs with a stable content hash derived from the file name. */
function ph(...files: string[]): { file: string; hash: string }[] {
  return files.map((file) => ({ file, hash: `h:${file}` }));
}

async function createTestDb(): Promise<Database> {
  const mod = await import("libsql");
  const Libsql = (mod.default ?? mod) as unknown as new (path: string) => any;
  const db = new Libsql(":memory:");
  db.pragma("journal_mode = WAL");
  return {
    exec: (sql: string) => db.exec(sql),
    prepare: (sql: string) => {
      const stmt = db.prepare(sql);
      return {
        run: (...params: unknown[]) => stmt.run(...params),
        get: (...params: unknown[]) => stmt.get(...params),
        all: (...params: unknown[]) => stmt.all(...params),
      };
    },
    close: () => db.close(),
  };
}

describe("pages db", () => {
  let db: Database;

  beforeEach(async () => {
    db = await createTestDb();
    initDb(db);
  });

  afterEach(() => {
    db.close();
  });

  it("initDb creates published_pages table", () => {
    // Should not throw on second call
    initDb(db);
    const pages = getPublishedPages(db, "test");
    assert.deepEqual(pages, []);
  });

  it("syncPublishedPages adds new files", () => {
    const diff = syncPublishedPages(db, "mind1", ph("index.html", "about.html"));
    assert.deepEqual(diff.added, ["index.html", "about.html"]);
    assert.deepEqual(diff.removed, []);
    assert.deepEqual(diff.updated, []);

    const pages = getPublishedPages(db, "mind1");
    assert.equal(pages.length, 2);
    assert.equal(pages[0].file, "about.html");
    assert.equal(pages[1].file, "index.html");
  });

  it("syncPublishedPages detects removed files", () => {
    syncPublishedPages(db, "mind1", ph("index.html", "about.html"));
    const diff = syncPublishedPages(db, "mind1", ph("index.html"));
    assert.deepEqual(diff.added, []);
    assert.deepEqual(diff.removed, ["about.html"]);
    assert.deepEqual(diff.updated, []);
  });

  it("syncPublishedPages does not bump updated_at for unchanged files", () => {
    syncPublishedPages(db, "mind1", ph("index.html", "about.html"));
    db.prepare("UPDATE published_pages SET updated_at = '2020-01-01 00:00:00'").run();

    const diff = syncPublishedPages(db, "mind1", ph("index.html", "about.html"));
    assert.deepEqual(diff.updated, []);

    const pages = getPublishedPages(db, "mind1");
    assert.equal(pages[0].updated_at, "2020-01-01 00:00:00");
    assert.equal(pages[1].updated_at, "2020-01-01 00:00:00");
  });

  it("syncPublishedPages bumps updated_at only for changed files", () => {
    syncPublishedPages(db, "mind1", ph("index.html", "about.html"));
    db.prepare("UPDATE published_pages SET updated_at = '2020-01-01 00:00:00'").run();

    const diff = syncPublishedPages(db, "mind1", [
      { file: "index.html", hash: "h:index.html" },
      { file: "about.html", hash: "changed" },
    ]);
    assert.deepEqual(diff.updated, ["about.html"]);

    const pages = getPublishedPages(db, "mind1");
    const about = pages.find((p) => p.file === "about.html");
    const index = pages.find((p) => p.file === "index.html");
    assert.notEqual(about?.updated_at, "2020-01-01 00:00:00");
    assert.equal(index?.updated_at, "2020-01-01 00:00:00");
  });

  it("syncPublishedPages handles empty list", () => {
    syncPublishedPages(db, "mind1", ph("index.html"));
    const diff = syncPublishedPages(db, "mind1", ph());
    assert.deepEqual(diff.removed, ["index.html"]);
  });

  it("getRecentPages returns pages ordered by updated_at", () => {
    syncPublishedPages(db, "mind1", ph("a.html"));
    syncPublishedPages(db, "mind2", ph("b.html"));

    const pages = getRecentPages(db);
    assert.equal(pages.length, 2);
    // mind2's b.html was synced last
    assert.equal(pages[0].mind, "mind2");
    assert.equal(pages[1].mind, "mind1");
  });

  it("getRecentPages filters by mind", () => {
    syncPublishedPages(db, "mind1", ph("a.html"));
    syncPublishedPages(db, "mind2", ph("b.html"));

    const pages = getRecentPages(db, { mind: "mind1" });
    assert.equal(pages.length, 1);
    assert.equal(pages[0].mind, "mind1");
  });

  it("syncSystemPages syncs _commons entries", () => {
    syncSystemPages(db, ph("index.html", "about.html"));
    const pages = getPublishedPages(db, "_commons");
    assert.equal(pages.length, 2);

    // Removes deleted files, keeps existing
    syncSystemPages(db, ph("index.html"));
    const after = getPublishedPages(db, "_commons");
    assert.equal(after.length, 1);
    assert.equal(after[0].file, "index.html");
  });

  it("getAllSites ranks sites by most-recent update, not insertion order", () => {
    syncPublishedPages(db, "mind1", ph("a.html")); // lower id
    syncPublishedPages(db, "mind2", ph("b.html", "c.html")); // higher id

    // Without touching timestamps, mind2 leads only via the id tiebreak. Make
    // mind1 strictly newer so real recency (updated_at) must decide the order.
    db.prepare(
      "UPDATE published_pages SET updated_at = '2999-01-01 00:00:00' WHERE mind = 'mind1'",
    ).run();

    const sites = getAllSites(db);
    assert.equal(sites.length, 2);
    // mind1 now ranks first purely on updated_at — this fails if the query drops
    // `updated_at DESC` and orders by id alone.
    assert.equal(sites[0].mind, "mind1");
    assert.equal(sites[0].files.length, 1);
    assert.equal(sites[1].mind, "mind2");
    assert.equal(sites[1].files.length, 2);
  });

  it("getAllSites puts a site's index first even when another page is newer", () => {
    syncPublishedPages(db, "mind1", ph("index.html", "about.html"));
    // Make about.html strictly newer than the index; index must still lead.
    db.prepare(
      "UPDATE published_pages SET updated_at = '2999-01-01 00:00:00' WHERE mind = 'mind1' AND file = 'about.html'",
    ).run();

    const sites = getAllSites(db);
    // Fails if sortSiteFiles' index-first branch is removed (about would lead on recency).
    assert.equal(sites[0].files[0].file, "index.html");
    assert.equal(sites[0].files[1].file, "about.html");
  });

  it("getAllSites excludes _commons pages", () => {
    syncPublishedPages(db, "mind1", ph("index.html"));
    syncSystemPages(db, ph("shared.html"));

    const sites = getAllSites(db);
    assert.equal(sites.length, 1);
    assert.equal(sites[0].mind, "mind1");
  });

  it("syncSystemPages stores author", () => {
    syncSystemPages(db, ph("index.html"), "alice");
    const pages = getPublishedPages(db, "_commons");
    assert.equal(pages[0].author, "alice");
  });

  it("syncSystemPages updates author when content changes", () => {
    syncSystemPages(db, ph("index.html"), "alice");
    syncSystemPages(db, [{ file: "index.html", hash: "changed" }], "bob");
    const pages = getPublishedPages(db, "_commons");
    assert.equal(pages[0].author, "bob");
  });

  it("syncSystemPages preserves author and updated_at for unchanged files", () => {
    syncSystemPages(db, ph("index.html", "about.html"), "alice");
    db.prepare("UPDATE published_pages SET updated_at = '2020-01-01 00:00:00'").run();

    // bob publishes a change to about.html only — index.html is untouched
    syncSystemPages(
      db,
      [
        { file: "index.html", hash: "h:index.html" },
        { file: "about.html", hash: "changed" },
      ],
      "bob",
    );

    const pages = getPublishedPages(db, "_commons");
    const index = pages.find((p) => p.file === "index.html");
    const about = pages.find((p) => p.file === "about.html");
    assert.equal(index?.author, "alice");
    assert.equal(index?.updated_at, "2020-01-01 00:00:00");
    assert.equal(about?.author, "bob");
    assert.notEqual(about?.updated_at, "2020-01-01 00:00:00");
  });

  it("syncSystemPages preserves author when not provided", () => {
    syncSystemPages(db, ph("index.html"), "alice");
    syncSystemPages(db, [{ file: "index.html", hash: "changed" }]);
    const pages = getPublishedPages(db, "_commons");
    assert.equal(pages[0].author, "alice");
  });

  it("getSystemPages returns null when empty", () => {
    assert.equal(getSystemPages(db), null);
  });

  it("getSystemPages returns system site with author, index first", () => {
    // index.html inserted first (lower id); without index-first logic the id
    // tiebreak would bury it behind about.html.
    syncSystemPages(db, ph("index.html", "about.html"), "alice");
    // ...and make about.html strictly newer, so recency alone would rank it first.
    db.prepare(
      "UPDATE published_pages SET updated_at = '2999-01-01 00:00:00' WHERE mind = '_commons' AND file = 'about.html'",
    ).run();

    const site = getSystemPages(db);
    assert.ok(site);
    assert.equal(site.mind, "_commons");
    assert.equal(site.files.length, 2);
    // index leads despite about.html being both newer and higher-id
    assert.equal(site.files[0].file, "index.html");
    assert.equal(site.files[0].author, "alice");
  });
});

// ---------------------------------------------------------------------------
// command unit tests
// ---------------------------------------------------------------------------

import { createCommands } from "../packages/extensions/pages/src/commands.js";
import { pagesIsolationChownPaths } from "../packages/extensions/pages/src/shared-pages.js";

describe("pages commands", () => {
  let mindDir: string;
  let pagesDir: string;
  let dataDir: string;
  let db: Database;

  beforeEach(async () => {
    const base = resolve(tmpdir(), `volute-test-cmd-${Date.now()}`);
    mindDir = resolve(base, "mind");
    pagesDir = resolve(mindDir, "home", "pages");
    dataDir = resolve(base, "data");
    mkdirSync(pagesDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    db = await createTestDb();
    initDb(db);
  });

  afterEach(() => {
    if (existsSync(resolve(mindDir, ".."))) rmSync(resolve(mindDir, ".."), { recursive: true });
    db.close();
  });

  function makeCtx(mindName = "test-mind", minds?: { name: string; mindType: any; stage?: any }[]) {
    const events: any[] = [];
    return {
      mindName,
      db,
      listMinds: async () => minds ?? [{ name: mindName, mindType: "mind", stage: "sprouted" }],
      authMiddleware: (() => {}) as any,
      resolveUser: () => null,
      getUser: async () => null,
      getUserByUsername: async () => null,
      publishActivity: (e: any) => events.push(e),
      getMindDir: async (name: string) => (name === mindName ? mindDir : null),
      getSystemsConfig: () => null,
      announceToCommons: async () => {},
      isIsolationEnabled: () => false,
      getMindUser: (name: string) => `mind-${name}`,
      dataDir,
      _events: events,
    };
  }

  it("publish command copies files to snapshot and syncs DB", async () => {
    writeFileSync(resolve(pagesDir, "index.html"), "<h1>Hello</h1>");
    writeFileSync(resolve(pagesDir, "style.css"), "body { color: red; }");

    const commands = createCommands();
    const ctx = makeCtx();
    const result = await commands.publish.handler(
      { args: {}, flags: { remote: false, shared: false }, rest: [] },
      ctx,
    );

    assert.ok("output" in result);
    assert.ok(result.output.includes("Published 1 files"));
    assert.ok(result.output.includes("1 new"));

    // Verify snapshot was created
    const snapshotDir = resolve(dataDir, "sites", "test-mind");
    assert.ok(existsSync(resolve(snapshotDir, "index.html")));
    assert.ok(existsSync(resolve(snapshotDir, "style.css")));

    // Verify DB was updated (only HTML files tracked)
    const pages = getPublishedPages(db, "test-mind");
    assert.equal(pages.length, 1);
    assert.equal(pages[0].file, "index.html");

    // Verify activity event
    assert.equal(ctx._events.length, 1);
    assert.equal(ctx._events[0].type, "page_published");
    assert.equal(ctx._events[0].metadata.url, "/minds/test-mind/pages/index.html");
    assert.equal(ctx._events[0].metadata.iframeUrl, "/ext/pages/public/test-mind/index.html");
  });

  it("publish command reports removed files", async () => {
    // First publish with two HTML files
    writeFileSync(resolve(pagesDir, "index.html"), "<h1>Hello</h1>");
    writeFileSync(resolve(pagesDir, "about.html"), "<h1>About</h1>");
    const commands = createCommands();
    const ctx = makeCtx();
    await commands.publish.handler(
      { args: {}, flags: { remote: false, shared: false }, rest: [] },
      ctx,
    );

    // Remove about.html and re-publish
    rmSync(resolve(pagesDir, "about.html"));
    ctx._events.length = 0;
    const result = await commands.publish.handler(
      { args: {}, flags: { remote: false, shared: false }, rest: [] },
      ctx,
    );

    assert.ok("output" in result);
    assert.ok(result.output.includes("1 removed"));

    // Verify removal event
    const removeEvents = ctx._events.filter((e: any) => e.type === "page_removed");
    assert.equal(removeEvents.length, 1);
    assert.equal(removeEvents[0].metadata.file, "about.html");
  });

  it("publish command does not report unchanged files as updated", async () => {
    writeFileSync(resolve(pagesDir, "index.html"), "<h1>Hello</h1>");
    writeFileSync(resolve(pagesDir, "about.html"), "<h1>About</h1>");
    const commands = createCommands();
    const ctx = makeCtx();
    await commands.publish.handler(
      { args: {}, flags: { remote: false, shared: false }, rest: [] },
      ctx,
    );

    // Re-publish with only one file changed
    writeFileSync(resolve(pagesDir, "about.html"), "<h1>About v2</h1>");
    const result = await commands.publish.handler(
      { args: {}, flags: { remote: false, shared: false }, rest: [] },
      ctx,
    );

    assert.ok("output" in result);
    assert.ok(result.output.includes("1 updated"), `expected "1 updated" in: ${result.output}`);
    assert.ok(!result.output.includes("2 updated"), `unchanged file counted: ${result.output}`);
  });

  it("publish command excludes _system/ from snapshot", async () => {
    writeFileSync(resolve(pagesDir, "index.html"), "<h1>Hello</h1>");
    const systemDir = resolve(pagesDir, "_system");
    mkdirSync(systemDir, { recursive: true });
    writeFileSync(resolve(systemDir, "shared.html"), "<h1>Shared</h1>");

    const commands = createCommands();
    const ctx = makeCtx();
    await commands.publish.handler(
      { args: {}, flags: { remote: false, shared: false }, rest: [] },
      ctx,
    );

    const snapshotDir = resolve(dataDir, "sites", "test-mind");
    assert.ok(existsSync(resolve(snapshotDir, "index.html")));
    assert.ok(!existsSync(resolve(snapshotDir, "_system")));
    assert.ok(!existsSync(resolve(snapshotDir, "_system", "shared.html")));
  });

  it("publish command rejects when no pages dir exists", async () => {
    rmSync(pagesDir, { recursive: true });
    const commands = createCommands();
    const result = await commands.publish.handler(
      { args: {}, flags: { remote: false, shared: false }, rest: [] },
      makeCtx(),
    );
    assert.ok("error" in result);
    assert.ok(result.error.includes("No pages directory"));
  });

  it("list command shows published and draft files", async () => {
    writeFileSync(resolve(pagesDir, "published.html"), "<h1>Pub</h1>");
    writeFileSync(resolve(pagesDir, "draft.html"), "<h1>Draft</h1>");

    // Publish one file
    const commands = createCommands();
    const ctx = makeCtx();
    syncPublishedPages(db, "test-mind", ph("published.html"));

    const result = await commands.list.handler(
      { args: {}, flags: { all: false, shared: false }, rest: [] },
      ctx,
    );
    assert.ok("output" in result);
    assert.ok(result.output.includes("draft"));
    assert.ok(result.output.includes("published"));
    assert.ok(result.output.includes("draft.html"));
    assert.ok(result.output.includes("published.html"));
  });

  it("publish command tracks .md files in DB", async () => {
    writeFileSync(resolve(pagesDir, "index.html"), "<h1>Hello</h1>");
    writeFileSync(resolve(pagesDir, "about.md"), "# About\n\nAbout page.\n");

    const commands = createCommands();
    const ctx = makeCtx();
    const result = await commands.publish.handler(
      { args: {}, flags: { remote: false, shared: false }, rest: [] },
      ctx,
    );

    assert.ok("output" in result);
    assert.ok(result.output.includes("Published 2 files"));

    const pages = getPublishedPages(db, "test-mind");
    assert.equal(pages.length, 2);
    const files = pages.map((p) => p.file).sort();
    assert.deepEqual(files, ["about.md", "index.html"]);
  });

  it("list command shows .md files", async () => {
    writeFileSync(resolve(pagesDir, "index.html"), "<h1>Hello</h1>");
    writeFileSync(resolve(pagesDir, "post.md"), "# Post\n");
    syncPublishedPages(db, "test-mind", ph("index.html"));

    const commands = createCommands();
    const ctx = makeCtx();
    const result = await commands.list.handler(
      { args: {}, flags: { all: false, shared: false }, rest: [] },
      ctx,
    );
    assert.ok("output" in result);
    assert.ok(result.output.includes("post.md"), "should list .md draft");
    assert.ok(result.output.includes("index.html"), "should list .html published");
  });

  it("list --all queries across minds", async () => {
    syncPublishedPages(db, "mind-a", ph("index.html"));
    syncPublishedPages(db, "mind-b", ph("about.html"));

    const commands = createCommands();
    const ctx = makeCtx();
    const result = await commands.list.handler(
      { args: {}, flags: { all: true, shared: false }, rest: [] },
      ctx,
    );
    assert.ok("output" in result);
    assert.ok(result.output.includes("mind-a"));
    assert.ok(result.output.includes("mind-b"));
  });

  it("list --all shows system pages with author", async () => {
    syncSystemPages(db, ph("shared.html"), "alice");
    syncPublishedPages(db, "mind-a", ph("index.html"));

    const commands = createCommands();
    const ctx = makeCtx();
    const result = await commands.list.handler(
      { args: {}, flags: { all: true, shared: false }, rest: [] },
      ctx,
    );
    assert.ok("output" in result);
    assert.ok(result.output.includes("_commons"));
    assert.ok(result.output.includes("alice"));
    assert.ok(result.output.includes("mind-a"));
  });

  it("list --all works without a mind name", async () => {
    syncPublishedPages(db, "mind-a", ph("index.html"));

    const commands = createCommands();
    const ctx = makeCtx();
    ctx.mindName = undefined as any;
    const result = await commands.list.handler(
      { args: {}, flags: { all: true, shared: false }, rest: [] },
      ctx,
    );
    assert.ok("output" in result);
    assert.ok(result.output.includes("mind-a"));
  });

  // ---- #802: a resident who has published nothing produces no site to be
  // unlinked, so the report used to skip them entirely and print an all-clear at
  // a commons most residents were absent from. ----
  it("commons report names residents who have no site at all", async () => {
    const repoDir = resolve(dataDir, "repo");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(resolve(repoDir, "index.md"), "welcome — see [oren](../oren/)");
    syncPublishedPages(db, "oren", ph("index.html"));

    const commands = createCommands();
    const ctx = makeCtx("oren", [
      { name: "oren", mindType: "mind", stage: "sprouted" },
      { name: "thea", mindType: "mind", stage: "sprouted" },
    ]);
    const result = await commands.commons.handler({ args: {}, flags: {}, rest: [] }, ctx);

    assert.ok("output" in result);
    assert.ok(
      result.output.includes("Residents without a site: thea"),
      `expected thea to be named, got:\n${result.output}`,
    );
    assert.ok(
      !result.output.includes("all present and linked"),
      "must not claim all-clear while a resident is absent",
    );
  });

  it("commons report is all-clear only when every resident is present and linked", async () => {
    const repoDir = resolve(dataDir, "repo");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(resolve(repoDir, "index.md"), "welcome — see [oren](../oren/)");
    syncPublishedPages(db, "oren", ph("index.html"));

    const commands = createCommands();
    const ctx = makeCtx("oren", [{ name: "oren", mindType: "mind", stage: "sprouted" }]);
    const result = await commands.commons.handler({ args: {}, flags: {}, rest: [] }, ctx);

    assert.ok("output" in result);
    assert.ok(result.output.includes("all present and linked"));
  });

  it("commons report exempts the spirit and unsprouted seeds from needing a site", async () => {
    const repoDir = resolve(dataDir, "repo");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(resolve(repoDir, "index.md"), "welcome — see [oren](../oren/)");
    syncPublishedPages(db, "oren", ph("index.html"));

    const commands = createCommands();
    const ctx = makeCtx("oren", [
      { name: "oren", mindType: "mind", stage: "sprouted" },
      { name: "volute", mindType: "spirit", stage: "sprouted" },
      { name: "sprig", mindType: "mind", stage: "seed" },
    ]);
    const result = await commands.commons.handler({ args: {}, flags: {}, rest: [] }, ctx);

    assert.ok("output" in result);
    assert.ok(result.output.includes("all present and linked"));
  });
});

// ---------------------------------------------------------------------------
// systems-config unit tests
// ---------------------------------------------------------------------------

describe("systems-config", () => {
  afterEach(() => {
    try {
      unlinkSync(configPath());
    } catch {}
  });

  it("readSystemsConfig returns null when no config exists", () => {
    assert.equal(readSystemsConfig(), null);
  });

  it("writeSystemsConfig + readSystemsConfig roundtrips", () => {
    writeSystemsConfig({
      apiKey: "vp_test123",
      system: "my-system",
      apiUrl: "https://volute.systems",
    });
    const config = readSystemsConfig();
    assert.deepEqual(config, {
      apiKey: "vp_test123",
      system: "my-system",
      apiUrl: "https://volute.systems",
    });
  });

  it("writeSystemsConfig sets file permissions to 0600", () => {
    writeSystemsConfig({
      apiKey: "vp_secret",
      system: "test",
      apiUrl: "https://volute.systems",
    });
    const mode = statSync(configPath()).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it("readSystemsConfig returns null for invalid JSON", () => {
    mkdirSync(voluteSystemDir(), { recursive: true });
    writeFileSync(configPath(), "not json");
    assert.equal(readSystemsConfig(), null);
  });

  it("readSystemsConfig returns null if apiKey is missing", () => {
    mkdirSync(voluteSystemDir(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ system: "test" }));
    assert.equal(readSystemsConfig(), null);
  });

  it("readSystemsConfig returns null if system is missing", () => {
    mkdirSync(voluteSystemDir(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ apiKey: "vp_key" }));
    assert.equal(readSystemsConfig(), null);
  });

  it("readSystemsConfig defaults apiUrl when missing", () => {
    mkdirSync(voluteSystemDir(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ apiKey: "vp_key", system: "test" }));
    const config = readSystemsConfig();
    assert.equal(config?.apiUrl, "https://volute.systems");
  });

  it("readSystemsConfig preserves custom apiUrl", () => {
    writeSystemsConfig({
      apiKey: "vp_key",
      system: "test",
      apiUrl: "http://localhost:9999",
    });
    const config = readSystemsConfig();
    assert.equal(config?.apiUrl, "http://localhost:9999");
  });

  it("deleteSystemsConfig removes the file", () => {
    writeSystemsConfig({
      apiKey: "vp_key",
      system: "test",
      apiUrl: "https://volute.systems",
    });
    assert.ok(existsSync(configPath()));
    const result = deleteSystemsConfig();
    assert.equal(result, true);
    assert.ok(!existsSync(configPath()));
  });

  it("deleteSystemsConfig returns false when no file exists", () => {
    assert.equal(deleteSystemsConfig(), false);
  });
});

// ---------------------------------------------------------------------------
// Daemon API tests for systems management
// ---------------------------------------------------------------------------

/** Collect body from an IncomingMessage */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
  });
}

/** Helper to build request headers that pass auth + CSRF */
function adminHeaders(cookie: string) {
  return {
    Cookie: `volute_session=${cookie}`,
    Origin: "http://localhost",
    "Content-Type": "application/json",
  };
}

describe("system API routes", () => {
  let server: Server;
  let baseUrl: string;
  let handler: (req: IncomingMessage, res: ServerResponse) => void;
  let sessionId: string;
  const MIND_NAME = "pages-test-mind";
  const originalSystemsUrl = process.env.VOLUTE_SYSTEMS_URL;

  async function cleanupAuth() {
    const db = await getDb();
    await db.delete(users).where(eq(users.username, "pages-admin"));
  }

  async function setupAuth(): Promise<string> {
    const user = await createUser("pages-admin", "pass");
    await approveUser(user.id);
    sessionId = await createSession(user.id);
    return sessionId;
  }

  before(async () => {
    // Start mock HTTP server to act as volute.systems
    server = createServer((req, res) => handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("bad address");
    baseUrl = `http://127.0.0.1:${addr.port}`;
    process.env.VOLUTE_SYSTEMS_URL = baseUrl;

    addMind(MIND_NAME, 14900);

    // Load extensions into the app so /api/ext/pages/* routes are available
    const { default: app } = await import("../packages/daemon/src/web/app.js");
    await loadAllExtensions(app, authMiddleware);
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (originalSystemsUrl === undefined) delete process.env.VOLUTE_SYSTEMS_URL;
    else process.env.VOLUTE_SYSTEMS_URL = originalSystemsUrl;
    removeMind(MIND_NAME);
  });

  afterEach(async () => {
    try {
      unlinkSync(configPath());
    } catch {}
    handler = (_req, res) => {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "not found" }));
    };
    await cleanupAuth();
  });

  // -----------------------------------------------------------------------
  // register
  // -----------------------------------------------------------------------
  describe("register", () => {
    it("POST /api/v1/system/register registers and saves config", async () => {
      handler = async (req, res) => {
        assert.equal(req.method, "POST");
        assert.equal(req.url, "/api/register");
        const body = JSON.parse(await readBody(req));
        assert.equal(body.name, "my-system");
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ apiKey: "vp_newkey", system: "my-system" }));
      };

      const cookie = await setupAuth();
      const { default: app } = await import("../packages/daemon/src/web/app.js");
      const res = await app.request("http://localhost/api/v1/system/register", {
        method: "POST",
        headers: adminHeaders(cookie),
        body: JSON.stringify({ name: "my-system" }),
      });

      assert.equal(res.status, 200);
      const data = (await res.json()) as { system: string };
      assert.equal(data.system, "my-system");

      const config = readSystemsConfig();
      assert.equal(config?.apiKey, "vp_newkey");
      assert.equal(config?.system, "my-system");
    });

    it("POST /api/v1/system/register returns 400 if already registered", async () => {
      writeSystemsConfig({ apiKey: "vp_existing", system: "existing", apiUrl: baseUrl });
      const cookie = await setupAuth();
      const { default: app } = await import("../packages/daemon/src/web/app.js");
      const res = await app.request("http://localhost/api/v1/system/register", {
        method: "POST",
        headers: adminHeaders(cookie),
        body: JSON.stringify({ name: "new-name" }),
      });
      assert.equal(res.status, 400);
    });
  });

  // -----------------------------------------------------------------------
  // login
  // -----------------------------------------------------------------------
  describe("login", () => {
    it("POST /api/v1/system/login validates key and saves config", async () => {
      handler = (req, res) => {
        assert.equal(req.method, "GET");
        assert.equal(req.url, "/api/whoami");
        assert.equal(req.headers.authorization, "Bearer vp_mykey");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ system: "test-system" }));
      };

      const cookie = await setupAuth();
      const { default: app } = await import("../packages/daemon/src/web/app.js");
      const res = await app.request("http://localhost/api/v1/system/login", {
        method: "POST",
        headers: adminHeaders(cookie),
        body: JSON.stringify({ key: "vp_mykey" }),
      });

      assert.equal(res.status, 200);
      const config = readSystemsConfig();
      assert.equal(config?.apiKey, "vp_mykey");
      assert.equal(config?.system, "test-system");
    });

    it("POST /api/v1/system/login returns 400 if already logged in", async () => {
      writeSystemsConfig({ apiKey: "vp_existing", system: "existing", apiUrl: baseUrl });
      const cookie = await setupAuth();
      const { default: app } = await import("../packages/daemon/src/web/app.js");
      const res = await app.request("http://localhost/api/v1/system/login", {
        method: "POST",
        headers: adminHeaders(cookie),
        body: JSON.stringify({ key: "vp_newkey" }),
      });
      assert.equal(res.status, 400);
    });
  });

  // -----------------------------------------------------------------------
  // logout
  // -----------------------------------------------------------------------
  describe("logout", () => {
    it("POST /api/v1/system/logout removes credentials", async () => {
      writeSystemsConfig({ apiKey: "vp_key", system: "test", apiUrl: baseUrl });
      assert.ok(existsSync(configPath()));

      const cookie = await setupAuth();
      const { default: app } = await import("../packages/daemon/src/web/app.js");
      const res = await app.request("http://localhost/api/v1/system/logout", {
        method: "POST",
        headers: { Cookie: `volute_session=${cookie}`, Origin: "http://localhost" },
      });

      assert.equal(res.status, 200);
      assert.ok(!existsSync(configPath()));
    });
  });

  // -----------------------------------------------------------------------
  // info
  // -----------------------------------------------------------------------
  describe("info", () => {
    it("GET /api/v1/system/info returns system name when configured", async () => {
      writeSystemsConfig({ apiKey: "vp_key", system: "my-system", apiUrl: baseUrl });
      const cookie = await setupAuth();
      const { default: app } = await import("../packages/daemon/src/web/app.js");
      const res = await app.request("/api/v1/system/info", {
        headers: { Cookie: `volute_session=${cookie}` },
      });

      assert.equal(res.status, 200);
      const data = (await res.json()) as { system: string | null };
      assert.equal(data.system, "my-system");
    });

    it("GET /api/v1/system/info returns null when not configured", async () => {
      const cookie = await setupAuth();
      const { default: app } = await import("../packages/daemon/src/web/app.js");
      const res = await app.request("/api/v1/system/info", {
        headers: { Cookie: `volute_session=${cookie}` },
      });

      assert.equal(res.status, 200);
      const data = (await res.json()) as { system: string | null };
      assert.equal(data.system, null);
    });
  });

  // -----------------------------------------------------------------------
  // pages publish via extension
  // -----------------------------------------------------------------------
  describe("pages publish", () => {
    it("PUT /api/ext/pages/publish proxies to volute.systems", async () => {
      writeSystemsConfig({ apiKey: "vp_pub", system: "my-system", apiUrl: baseUrl });

      let receivedAuth: string | undefined;
      handler = async (req, res) => {
        assert.equal(req.method, "PUT");
        assert.equal(req.url, `/api/pages/publish/${MIND_NAME}`);
        receivedAuth = req.headers.authorization;
        const body = JSON.parse(await readBody(req));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ url: "https://example.com", fileCount: Object.keys(body.files).length }),
        );
      };

      const cookie = await setupAuth();
      const { default: app } = await import("../packages/daemon/src/web/app.js");
      const res = await app.request(`http://localhost/api/ext/pages/publish/${MIND_NAME}`, {
        method: "PUT",
        headers: adminHeaders(cookie),
        body: JSON.stringify({ files: { "index.html": "PGgxPkhlbGxvPC9oMT4=" } }),
      });

      assert.equal(res.status, 200);
      assert.equal(receivedAuth, "Bearer vp_pub");
      const data = (await res.json()) as { url: string; fileCount: number };
      assert.equal(data.fileCount, 1);
    });

    it("PUT /api/ext/pages/publish returns 400 when not configured", async () => {
      const cookie = await setupAuth();
      const { default: app } = await import("../packages/daemon/src/web/app.js");
      const res = await app.request(`http://localhost/api/ext/pages/publish/${MIND_NAME}`, {
        method: "PUT",
        headers: adminHeaders(cookie),
        body: JSON.stringify({ files: {} }),
      });
      assert.equal(res.status, 400);
    });
  });

  // -----------------------------------------------------------------------
  // pages status via extension
  // -----------------------------------------------------------------------
  describe("pages status", () => {
    it("GET /api/ext/pages/status proxies to volute.systems", async () => {
      writeSystemsConfig({ apiKey: "vp_stat", system: "my-system", apiUrl: baseUrl });

      handler = (req, res) => {
        assert.equal(req.method, "GET");
        assert.equal(req.url, `/api/pages/status/${MIND_NAME}`);
        assert.equal(req.headers.authorization, "Bearer vp_stat");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            url: "https://example.com",
            fileCount: 5,
            deployedAt: "2026-01-15T12:00:00Z",
          }),
        );
      };

      const cookie = await setupAuth();
      const { default: app } = await import("../packages/daemon/src/web/app.js");
      const res = await app.request(`/api/ext/pages/status/${MIND_NAME}`, {
        headers: { Cookie: `volute_session=${cookie}` },
      });

      assert.equal(res.status, 200);
      const data = (await res.json()) as { url: string; fileCount: number; deployedAt: string };
      assert.equal(data.fileCount, 5);
    });

    it("GET /api/ext/pages/status returns 400 when not configured", async () => {
      const cookie = await setupAuth();
      const { default: app } = await import("../packages/daemon/src/web/app.js");
      const res = await app.request(`/api/ext/pages/status/${MIND_NAME}`, {
        headers: { Cookie: `volute_session=${cookie}` },
      });
      assert.equal(res.status, 400);
    });
  });
});

describe("pages isolation chown targets", () => {
  it("includes the parent home/pages directory so the mind can write to it", () => {
    const mindDir = "/minds/pip";
    const targets = pagesIsolationChownPaths(mindDir, null);
    assert.ok(
      targets.includes(resolve(mindDir, "home", "pages")),
      "parent pages dir must be chowned to the mind user",
    );
  });

  it("includes the worktree git dir when present", () => {
    const mindDir = "/minds/pip";
    const wtGitDir = "/data/repo/.git/worktrees/pip";
    const targets = pagesIsolationChownPaths(mindDir, wtGitDir);
    assert.ok(targets.includes(wtGitDir), "worktree git dir must be chowned");
  });

  it("omits the git dir when it cannot be resolved", () => {
    const targets = pagesIsolationChownPaths("/minds/pip", null);
    assert.equal(targets.length, 1);
  });
});
