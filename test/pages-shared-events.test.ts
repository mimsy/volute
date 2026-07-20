import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createCommands } from "../packages/extensions/pages/src/commands.js";
import { initDb } from "../packages/extensions/pages/src/db.js";
import {
  addPagesWorktree,
  collectPageFiles,
  ensurePagesRepo,
  pagesPull,
  pagesPullAndMerge,
} from "../packages/extensions/pages/src/shared-pages.js";
import type { Database } from "../packages/extensions/sdk/src/types.js";

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

describe("shared publish contributor tracking", () => {
  let dataDir: string, mindA: string, mindB: string;

  beforeEach(async () => {
    const base = mkdtempSync(join(tmpdir(), "pages-ev-"));
    dataDir = join(base, "data");
    mindA = join(base, "alpha");
    mindB = join(base, "beta");
    mkdirSync(dataDir, { recursive: true });
    await ensurePagesRepo(dataDir);
    await addPagesWorktree("alpha", mindA, dataDir);
    await addPagesWorktree("beta", mindB, dataDir);
  });

  it("reports changed files and no prior authors for a brand-new page", async () => {
    mkdirSync(join(mindA, "home/pages/_system"), { recursive: true });
    writeFileSync(join(mindA, "home/pages/_system/lore.md"), "# Lore\n");
    const r = await pagesPullAndMerge("alpha", mindA, dataDir, "start lore");
    assert.equal(r.ok, true);
    assert.deepEqual(r.changedFiles, ["lore.md"]);
    assert.deepEqual(r.priorAuthors, {}); // new file — nobody to notify
  });

  it("reports the prior author when another mind edits the page", async () => {
    mkdirSync(join(mindA, "home/pages/_system"), { recursive: true });
    writeFileSync(join(mindA, "home/pages/_system/lore.md"), "# Lore\n");
    await pagesPullAndMerge("alpha", mindA, dataDir, "start lore");
    // beta pulls main first, then edits the now-existing page — two branches
    // independently *creating* the same new path (without pulling first) is a
    // real git add/add conflict, not something the implicit rebase can resolve.
    await pagesPull("beta", mindB);
    const existing = readFileSync(join(mindB, "home/pages/_system/lore.md"), "utf-8");
    writeFileSync(join(mindB, "home/pages/_system/lore.md"), `${existing}more\n`);
    const r = await pagesPullAndMerge("beta", mindB, dataDir, "expand lore");
    assert.equal(r.ok, true);
    assert.deepEqual(r.changedFiles, ["lore.md"]);
    assert.deepEqual(r.priorAuthors, { "lore.md": ["alpha"] });
  });

  it("excludes the publisher and the repo-init identity from prior authors", async () => {
    mkdirSync(join(mindA, "home/pages/_system"), { recursive: true });
    writeFileSync(join(mindA, "home/pages/_system/lore.md"), "v1\n");
    await pagesPullAndMerge("alpha", mindA, dataDir, "one");
    writeFileSync(join(mindA, "home/pages/_system/lore.md"), "v2\n");
    const r = await pagesPullAndMerge("alpha", mindA, dataDir, "two");
    assert.deepEqual(r.priorAuthors, {}); // only alpha in history — nothing
  });

  it("collectPageFiles picks up .md as well as .html", () => {
    const d = mkdtempSync(join(tmpdir(), "cpf-"));
    writeFileSync(join(d, "a.html"), "");
    writeFileSync(join(d, "b.md"), "");
    writeFileSync(join(d, "c.txt"), "");
    assert.deepEqual(collectPageFiles(d), ["a.html", "b.md"]);
  });
});

describe("shared publish command events", () => {
  let dataDir: string, mindA: string, mindB: string;
  let db: Database;

  function makeCtx(mindName: string, mindDir: string) {
    const activity: any[] = [];
    const announcements: string[] = [];
    const notices: { mind: string; text: string }[] = [];
    return {
      mindName,
      db,
      dataDir,
      authMiddleware: (() => {}) as any,
      resolveUser: () => null,
      getUser: async () => null,
      getUserByUsername: async () => null,
      publishActivity: (e: any) => activity.push(e),
      getMindDir: (name: string) => (name === mindName ? mindDir : null),
      getSystemsConfig: () => null,
      announceToSystem: async (text: string) => {
        announcements.push(text);
      },
      recordNotice: async (mind: string, text: string) => {
        notices.push({ mind, text });
      },
      isIsolationEnabled: () => false,
      getMindUser: (name: string) => `mind-${name}`,
      _activity: activity,
      _announcements: announcements,
      _notices: notices,
    };
  }

  beforeEach(async () => {
    const base = mkdtempSync(join(tmpdir(), "pages-cmd-ev-"));
    dataDir = join(base, "data");
    mindA = join(base, "alpha");
    mindB = join(base, "beta");
    mkdirSync(dataDir, { recursive: true });
    await ensurePagesRepo(dataDir);
    await addPagesWorktree("alpha", mindA, dataDir);
    await addPagesWorktree("beta", mindB, dataDir);
    db = await createTestDb();
    initDb(db);
  });

  afterEach(() => {
    db.close();
  });

  it("announces a shared publish and fires a page_published activity event", async () => {
    writeFileSync(join(mindA, "home/pages/_system/lore.md"), "# Lore\n");
    const commands = createCommands();
    const ctx = makeCtx("alpha", mindA);
    const result = await commands.publish.handler(
      { args: { message: "start lore" }, flags: { remote: false, shared: true }, rest: [] },
      ctx as any,
    );
    assert.ok("output" in result, `expected output, got ${JSON.stringify(result)}`);

    assert.equal(ctx._activity.length, 1);
    assert.equal(ctx._activity[0].type, "page_published");
    assert.equal(ctx._activity[0].metadata.shared, true);
    assert.deepEqual(ctx._activity[0].metadata.files, ["lore.md"]);

    assert.equal(ctx._announcements.length, 1);
    assert.match(ctx._announcements[0], /alpha tended the commons: lore\.md — "start lore"/);

    // No prior authors on a brand-new page — nobody to notify.
    assert.equal(ctx._notices.length, 0);
  });

  it("notifies the prior author when another mind builds on their page", async () => {
    writeFileSync(join(mindA, "home/pages/_system/lore.md"), "# Lore\n");
    const commands = createCommands();
    await commands.publish.handler(
      { args: { message: "start lore" }, flags: { remote: false, shared: true }, rest: [] },
      makeCtx("alpha", mindA) as any,
    );

    await pagesPull("beta", mindB);
    const existing = readFileSync(join(mindB, "home/pages/_system/lore.md"), "utf-8");
    writeFileSync(join(mindB, "home/pages/_system/lore.md"), `${existing}more\n`);

    const ctxB = makeCtx("beta", mindB);
    const result = await commands.publish.handler(
      { args: { message: "expand lore" }, flags: { remote: false, shared: true }, rest: [] },
      ctxB as any,
    );
    assert.ok("output" in result, `expected output, got ${JSON.stringify(result)}`);

    assert.equal(ctxB._notices.length, 1);
    assert.equal(ctxB._notices[0].mind, "alpha");
    assert.match(ctxB._notices[0].text, /beta built on lore\.md in the commons/);
  });

  it("fires no events when there is nothing new to publish", async () => {
    writeFileSync(join(mindA, "home/pages/_system/lore.md"), "# Lore\n");
    const commands = createCommands();
    const ctx = makeCtx("alpha", mindA);
    await commands.publish.handler(
      { args: { message: "start lore" }, flags: { remote: false, shared: true }, rest: [] },
      ctx as any,
    );

    // Publish again with no changes — "Nothing to publish" short-circuits
    // before changedFiles/priorAuthors even exist on the result.
    const result = await commands.publish.handler(
      { args: { message: "again" }, flags: { remote: false, shared: true }, rest: [] },
      ctx as any,
    );
    assert.ok("output" in result && result.output.includes("Nothing to publish"));
    assert.equal(ctx._activity.length, 1); // only the first publish
    assert.equal(ctx._announcements.length, 1);
  });
});
