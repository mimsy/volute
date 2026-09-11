/**
 * A published page has to be a real file.
 *
 * `home/pages` belongs to the mind, so a mind can put a symbolic link in it
 * pointing anywhere on the host. Three separate places used to follow one: the
 * publish copy reproduced it inside the served snapshot, the public serve route —
 * which is unauthenticated, and reads as the daemon, root on a user-isolation
 * install — opened it, and nothing ever cleaned up a snapshot written before
 * either of those was fixed. Together that was a way for anyone who could reach
 * the port to read any file the daemon could open.
 *
 * These tests pin each of the three refusals, and pin that a refusal is *spoken*:
 * a page that silently fails to appear is a page its author goes on believing it
 * published.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Hono } from "hono";
import { initDb } from "../packages/extensions/pages/src/db.js";
import { publishPersonalPages } from "../packages/extensions/pages/src/publish.js";
import { createPublicRoutes } from "../packages/extensions/pages/src/routes.js";
import { sweepSnapshotSymlinks } from "../packages/extensions/pages/src/snapshot-sweep.js";
import type { Database, ExtensionContext } from "../packages/extensions/sdk/src/types.js";

const SECRET = "root-only-credential";

async function createTestDb(): Promise<Database> {
  const mod = await import("libsql");
  const Libsql = (mod.default ?? mod) as unknown as new (path: string) => any;
  const raw = new Libsql(":memory:");
  return {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => {
      const stmt = raw.prepare(sql);
      return {
        run: (...p: unknown[]) => stmt.run(...p),
        get: (...p: unknown[]) => stmt.get(...p),
        all: (...p: unknown[]) => stmt.all(...p),
      };
    },
    close: () => raw.close(),
  };
}

function makeCtx(dataDir: string, db: Database | null): ExtensionContext {
  return {
    db,
    dataDir,
    authMiddleware: (async (_c: unknown, next: () => Promise<void>) => next()) as never,
    requireSelf: () => (async (_c: unknown, next: () => Promise<void>) => next()) as never,
    resolveUser: () => null,
    getUser: async () => null,
    getUserByUsername: async () => null,
    publishActivity: () => {},
    getMindDir: async () => null,
    getSystemsConfig: () => null,
    announceToCommons: async () => {},
    recordNotice: async () => {},
    isIsolationEnabled: () => false,
    getMindUser: (name: string) => `mind-${name}`,
    getSpiritName: () => "volute",
  } as unknown as ExtensionContext;
}

describe("publish refuses to copy a symlink into the snapshot", () => {
  let mindDir: string;
  let dataDir: string;
  let outside: string;
  let pagesDir: string;
  let db: Database;

  beforeEach(async () => {
    mindDir = mkdtempSync(resolve(tmpdir(), "pages-pub-mind-"));
    dataDir = mkdtempSync(resolve(tmpdir(), "pages-pub-data-"));
    outside = mkdtempSync(resolve(tmpdir(), "pages-pub-out-"));
    pagesDir = resolve(mindDir, "home", "pages");
    mkdirSync(pagesDir, { recursive: true });
    writeFileSync(resolve(outside, "host-only.md"), SECRET);
    db = await createTestDb();
    initDb(db);
  });

  afterEach(() => {
    db.close();
    for (const d of [mindDir, dataDir, outside]) rmSync(d, { recursive: true, force: true });
  });

  it("leaves a symlinked page out of the snapshot and names it in the result", () => {
    writeFileSync(resolve(pagesDir, "index.html"), "<h1>real</h1>");
    symlinkSync(resolve(outside, "host-only.md"), resolve(pagesDir, "evil.md"));

    const result = publishPersonalPages(makeCtx(dataDir, db), "mimsy", mindDir);

    assert.ok(
      existsSync(resolve(result.snapshotDir, "index.html")),
      "the real page still publishes",
    );
    assert.ok(
      !existsSync(resolve(result.snapshotDir, "evil.md")),
      "the symlinked page must not reach the served snapshot",
    );
    assert.deepEqual(result.skipped, ["evil.md"], "and the mind is told which entry was skipped");
  });

  it("skips a symlinked directory as one entry, without copying what is under it", () => {
    writeFileSync(resolve(outside, "a.md"), SECRET);
    writeFileSync(resolve(outside, "b.md"), SECRET);
    symlinkSync(outside, resolve(pagesDir, "notes"));

    const result = publishPersonalPages(makeCtx(dataDir, db), "mimsy", mindDir);

    assert.ok(!existsSync(resolve(result.snapshotDir, "notes")), "no link, and no copy of it");
    assert.deepEqual(result.skipped, ["notes"]);
  });

  it("publishes an ordinary tree untouched and reports nothing skipped", () => {
    writeFileSync(resolve(pagesDir, "index.html"), "<h1>real</h1>");
    mkdirSync(resolve(pagesDir, "notes"));
    writeFileSync(resolve(pagesDir, "notes", "a.md"), "# a\n");

    const result = publishPersonalPages(makeCtx(dataDir, db), "mimsy", mindDir);

    assert.deepEqual(result.skipped, []);
    assert.equal(result.fileCount, 2);
    assert.ok(existsSync(resolve(result.snapshotDir, "notes", "a.md")));
  });
});

describe("the public serve route refuses a symlinked snapshot entry", () => {
  let dataDir: string;
  let outside: string;
  let snapshotDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(resolve(tmpdir(), "pages-serve-data-"));
    outside = mkdtempSync(resolve(tmpdir(), "pages-serve-out-"));
    snapshotDir = resolve(dataDir, "sites", "mimsy");
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(resolve(snapshotDir, "index.html"), "<h1>real</h1>");
    writeFileSync(resolve(outside, "host-only.html"), SECRET);
  });

  afterEach(() => {
    for (const d of [dataDir, outside]) rmSync(d, { recursive: true, force: true });
  });

  function app(): Hono {
    const a = new Hono();
    a.route("/public", createPublicRoutes(makeCtx(dataDir, null)));
    return a;
  }

  it("still serves a real page", async () => {
    const res = await app().request("/public/mimsy/index.html");
    assert.equal(res.status, 200);
    assert.match(await res.text(), /real/);
  });

  it("404s a page that is a symlink out of the snapshot, without leaking its bytes", async () => {
    symlinkSync(resolve(outside, "host-only.html"), resolve(snapshotDir, "evil.html"));

    const res = await app().request("/public/mimsy/evil.html");
    // 404 rather than 403: a distinct status would confirm the path is there.
    assert.equal(res.status, 404);
    assert.ok(!(await res.text()).includes(SECRET));
  });

  it("404s a page reached through a symlinked directory", async () => {
    mkdirSync(resolve(outside, "sub"));
    writeFileSync(resolve(outside, "sub", "index.html"), SECRET);
    symlinkSync(resolve(outside, "sub"), resolve(snapshotDir, "notes"));

    for (const path of ["/public/mimsy/notes/index.html", "/public/mimsy/notes"]) {
      const res = await app().request(path);
      assert.equal(res.status, 404, `expected 404 for ${path}`);
      assert.ok(!(await res.text()).includes(SECRET));
    }
  });

  it("404s a symlink pointing back inside the snapshot too", async () => {
    // Containment alone would allow this one. Publish never produces a link, so a
    // link in a snapshot is never something an author put there on purpose.
    symlinkSync(resolve(snapshotDir, "index.html"), resolve(snapshotDir, "alias.html"));
    const res = await app().request("/public/mimsy/alias.html");
    assert.equal(res.status, 404);
  });
});

describe("the `pages publish` command says what it refused", () => {
  // The function-level tests above pin `skipped`; this pins that it reaches the
  // author. A refusal nobody is told about is a page its author believes it
  // published, and `describeSkipped` is hand-wired into each command that publishes.
  let mindDir: string;
  let dataDir: string;
  let outside: string;
  let db: Database;

  beforeEach(async () => {
    mindDir = mkdtempSync(resolve(tmpdir(), "pages-cmd-mind-"));
    dataDir = mkdtempSync(resolve(tmpdir(), "pages-cmd-data-"));
    outside = mkdtempSync(resolve(tmpdir(), "pages-cmd-out-"));
    mkdirSync(resolve(mindDir, "home", "pages"), { recursive: true });
    writeFileSync(resolve(outside, "host-only.md"), SECRET);
    db = await createTestDb();
    initDb(db);
  });

  afterEach(() => {
    db.close();
    for (const d of [mindDir, dataDir, outside]) rmSync(d, { recursive: true, force: true });
  });

  it("names the skipped entry in the output a mind reads", async () => {
    const pagesDir = resolve(mindDir, "home", "pages");
    writeFileSync(resolve(pagesDir, "index.html"), "<h1>real</h1>");
    symlinkSync(resolve(outside, "host-only.md"), resolve(pagesDir, "evil.md"));

    const { createCommands } = await import("../packages/extensions/pages/src/commands.js");
    const ctx = {
      ...makeCtx(dataDir, db),
      mindName: "mimsy",
      getMindDir: async () => mindDir,
    } as unknown as ExtensionContext;

    const result = await commandOutput(
      createCommands().publish.handler(
        { args: {}, flags: { remote: false, shared: false }, rest: [] } as never,
        ctx,
      ),
    );
    assert.match(result, /Published 1 files/);
    assert.match(result, /Skipped 1 symlinked entry: evil\.md/);
  });
});

async function commandOutput(p: Promise<unknown>): Promise<string> {
  const result = (await p) as { output?: string; error?: string };
  assert.ok(result.output, `expected output, got error: ${result.error}`);
  return result.output;
}

describe("the commons checkout is covered at the point of reading", () => {
  // Nothing sweeps `dataDir/repo` — git owns it and restores a committed symlink on
  // every checkout — so both readers of that tree have to refuse one themselves.
  let dataDir: string;
  let outside: string;
  let repoDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(resolve(tmpdir(), "pages-commons-data-"));
    outside = mkdtempSync(resolve(tmpdir(), "pages-commons-out-"));
    repoDir = resolve(dataDir, "repo");
    mkdirSync(resolve(repoDir, ".git"), { recursive: true });
    writeFileSync(resolve(repoDir, "index.md"), "# commons\n");
    writeFileSync(resolve(repoDir, ".git", "config"), SECRET);
    writeFileSync(resolve(outside, "host-only.md"), SECRET);
  });

  afterEach(() => {
    for (const d of [dataDir, outside]) rmSync(d, { recursive: true, force: true });
  });

  function app(): Hono {
    const a = new Hono();
    a.route("/public", createPublicRoutes(makeCtx(dataDir, null)));
    return a;
  }

  it("serves a real commons page", async () => {
    const res = await app().request("/public/_commons/index.md");
    assert.equal(res.status, 200);
    assert.match(await res.text(), /commons/);
  });

  it("404s a commons page that is a symlink out of the repo", async () => {
    symlinkSync(resolve(outside, "host-only.md"), resolve(repoDir, "leak.md"));
    const res = await app().request("/public/_commons/leak.md");
    assert.equal(res.status, 404);
    assert.ok(!(await res.text()).includes(SECRET));
  });

  it("404s a dotfile reached through a symlinked directory", async () => {
    // The URL carries no dot segment, so the guard on the requested path waves it
    // through; only the check on the resolved path catches it. `.git` is the whole
    // history of the commons, pages their authors later took down included.
    symlinkSync(resolve(repoDir, ".git"), resolve(repoDir, "link"));
    const res = await app().request("/public/_commons/link/config");
    assert.equal(res.status, 404);
    assert.ok(!(await res.text()).includes(SECRET));
  });

  it("readPageBody refuses a symlinked page instead of reading through it", async () => {
    const { readPageBody } = await import("../packages/extensions/pages/src/commands.js");
    symlinkSync(resolve(outside, "host-only.md"), resolve(repoDir, "leak.md"));
    const ctx = makeCtx(dataDir, null);
    assert.equal(readPageBody(ctx, { mind: "_commons", file: "leak.md" }), null);
    assert.match(
      readPageBody(ctx, { mind: "_commons", file: "index.md" }) ?? "",
      /commons/,
      "a real commons page still reads",
    );
  });
});

describe("the start-up sweep clears symlinks already sitting in snapshots", () => {
  let dataDir: string;
  let outside: string;

  beforeEach(() => {
    dataDir = mkdtempSync(resolve(tmpdir(), "pages-sweep-data-"));
    outside = mkdtempSync(resolve(tmpdir(), "pages-sweep-out-"));
    writeFileSync(resolve(outside, "host-only.md"), SECRET);
  });

  afterEach(() => {
    for (const d of [dataDir, outside]) rmSync(d, { recursive: true, force: true });
  });

  it("removes links at any depth, leaves real files, and never follows one", () => {
    const mimsy = resolve(dataDir, "sites", "mimsy");
    mkdirSync(resolve(mimsy, "notes"), { recursive: true });
    writeFileSync(resolve(mimsy, "index.html"), "<h1>real</h1>");
    writeFileSync(resolve(mimsy, "notes", "a.md"), "# a\n");
    symlinkSync(resolve(outside, "host-only.md"), resolve(mimsy, "evil.md"));
    symlinkSync(resolve(outside, "host-only.md"), resolve(mimsy, "notes", "deep.md"));
    // A whole mind directory replaced by a link: unlinked, never descended into.
    symlinkSync(outside, resolve(dataDir, "sites", "pip"));

    const removed = sweepSnapshotSymlinks(dataDir);

    assert.equal(removed.length, 3);
    assert.ok(!existsSync(resolve(mimsy, "evil.md")));
    assert.ok(!existsSync(resolve(mimsy, "notes", "deep.md")));
    assert.ok(!existsSync(resolve(dataDir, "sites", "pip")));
    assert.ok(existsSync(resolve(mimsy, "index.html")), "real files are left alone");
    assert.ok(existsSync(resolve(mimsy, "notes", "a.md")));
    // The link's target is untouched — a sweep that followed one would delete the
    // host's file instead of the link to it.
    assert.ok(existsSync(resolve(outside, "host-only.md")));
  });

  it("is idempotent and tolerates a missing sites/ directory", () => {
    assert.deepEqual(sweepSnapshotSymlinks(dataDir), [], "a fresh install has no sites/");
    const mimsy = resolve(dataDir, "sites", "mimsy");
    mkdirSync(mimsy, { recursive: true });
    symlinkSync(resolve(outside, "host-only.md"), resolve(mimsy, "evil.md"));
    assert.equal(sweepSnapshotSymlinks(dataDir).length, 1);
    assert.deepEqual(sweepSnapshotSymlinks(dataDir), [], "a second run finds nothing");
  });

  it("removes a link whose target is already gone", () => {
    const mimsy = resolve(dataDir, "sites", "mimsy");
    mkdirSync(mimsy, { recursive: true });
    const dangling = resolve(mimsy, "dangling.md");
    symlinkSync(resolve(outside, "never-existed.md"), dangling);
    assert.equal(sweepSnapshotSymlinks(dataDir).length, 1);
    assert.throws(() => lstatSync(dangling));
  });
});
