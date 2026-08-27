/**
 * Who owns a page the daemon wrote.
 *
 * `volute pages write` runs daemon-side — the CLI POSTs to the extension command
 * route — so on a user-isolation install the file is born owned by root and its
 * author cannot edit it. These tests pin the chown that hands it back, and pin it
 * at `writeQuickPage` rather than at one call site, because both the CLI command
 * and the comment-promotion route write through that one function.
 */
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { initDb } from "../packages/extensions/pages/src/db.js";
import {
  type ChownExec,
  chownToMind,
  resolvePagesWrite,
} from "../packages/extensions/pages/src/ownership.js";
import { verifyOwnership, writeQuickPage } from "../packages/extensions/pages/src/publish.js";
import type { Database, ExtensionContext } from "../packages/extensions/sdk/src/types.js";

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

/** Records what would have been run instead of running a real `chown`. */
function recordingExec(): { calls: string[][]; exec: ChownExec } {
  const calls: string[][] = [];
  return {
    calls,
    exec: async (cmd, args) => {
      calls.push([cmd, ...args]);
    },
  };
}

const failingExec: ChownExec = async () => {
  throw new Error("chown: invalid user");
};

describe("pages ownership helper", () => {
  it("does nothing when isolation is off — there is no other user to give files to", async () => {
    const { calls, exec } = recordingExec();
    const warning = await chownToMind(
      { isIsolationEnabled: () => false, getMindUser: (n) => `mind-${n}` },
      "mimsy",
      ["/tmp/a", "/tmp/b"],
      exec,
    );
    assert.equal(warning, null);
    assert.deepEqual(calls, []);
  });

  it("chowns every path to <mind-user>:volute in one call", async () => {
    const { calls, exec } = recordingExec();
    const warning = await chownToMind(
      { isIsolationEnabled: () => true, getMindUser: (n) => `mind-${n}` },
      "mimsy",
      ["/pages/notes", "/pages/notes/a.md"],
      exec,
    );
    assert.equal(warning, null);
    // `-h`: never dereference. A path that slipped past containment must not become
    // a way to hand away whatever it points at.
    assert.deepEqual(calls, [
      ["chown", "-h", "mind-mimsy:volute", "/pages/notes", "/pages/notes/a.md"],
    ]);
  });

  it("reports a failure instead of throwing, and names the mind and the paths", async () => {
    const warning = await chownToMind(
      { isIsolationEnabled: () => true, getMindUser: (n) => `mind-${n}` },
      "pip",
      ["/pages/notes/a.md"],
      failingExec,
    );
    assert.ok(warning, "a failed chown must be reported, not swallowed");
    assert.match(warning, /pip/);
    assert.match(warning, /a\.md/);
  });
});

describe("writeQuickPage hands the page back to its author", () => {
  let mindDir: string;
  let dataDir: string;
  let db: Database;

  beforeEach(async () => {
    mindDir = mkdtempSync(resolve(tmpdir(), "pages-own-mind-"));
    dataDir = mkdtempSync(resolve(tmpdir(), "pages-own-data-"));
    mkdirSync(resolve(mindDir, "home", "pages"), { recursive: true });
    db = await createTestDb();
    initDb(db);
  });

  afterEach(() => {
    db.close();
    rmSync(mindDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  function ctxWith(isolation: boolean): ExtensionContext {
    return {
      db,
      dataDir,
      authMiddleware: (async (_c: unknown, next: () => Promise<void>) => next()) as never,
      requireSelf: () => (async (_c: unknown, next: () => Promise<void>) => next()) as never,
      resolveUser: () => null,
      getUser: async () => null,
      getUserByUsername: async () => null,
      publishActivity: () => {},
      getMindDir: async () => mindDir,
      getSystemsConfig: () => null,
      announceToCommons: async () => {},
      recordNotice: async () => {},
      isIsolationEnabled: () => isolation,
      getMindUser: (name: string) => `mind-${name}`,
      getSpiritName: () => "volute",
    } as unknown as ExtensionContext;
  }

  it("chowns the written file AND the notes/ directory it created", async () => {
    const { calls, exec } = recordingExec();
    const result = await writeQuickPage(
      ctxWith(true),
      "mimsy",
      mindDir,
      "The tideline",
      "Something I noticed.",
      exec,
    );

    assert.equal(result.ownershipWarning, null);
    assert.equal(calls.length, 1, "one chown call");
    const [cmd, noDeref, spec, ...paths] = calls[0];
    assert.equal(cmd, "chown");
    assert.equal(noDeref, "-h");
    assert.equal(spec, "mind-mimsy:volute");
    // The directory as well as the file: mkdirSync ran as the daemon too, and a
    // mind that cannot write notes/ cannot put a second page beside its first.
    //
    // And *real* paths, not the ones composed by `resolve()` — chowning an
    // unresolved path is how a symlinked notes/ would have handed away its target.
    const realPages = realpathSync(resolve(mindDir, "home", "pages"));
    assert.deepEqual(paths.sort(), [
      resolve(realPages, "notes"),
      resolve(realPages, "notes", "the-tideline.md"),
    ]);
  });

  it("leaves files alone when isolation is off", async () => {
    const { calls, exec } = recordingExec();
    const result = await writeQuickPage(
      ctxWith(false),
      "mimsy",
      mindDir,
      "The tideline",
      "body",
      exec,
    );
    assert.deepEqual(calls, []);
    assert.equal(result.ownershipWarning, null);
  });

  it("still publishes when the chown fails, and says so", async () => {
    const result = await writeQuickPage(
      ctxWith(true),
      "mimsy",
      mindDir,
      "The tideline",
      "Something I noticed.",
      failingExec,
    );

    // The page is worth publishing even when its ownership is wrong — losing the
    // writing would be the worse failure of the two.
    assert.deepEqual(result.publish.diff.added, ["notes/the-tideline.md"]);
    assert.ok(result.ownershipWarning, "the author has to be told");
    assert.match(result.ownershipWarning, /mimsy/);
  });

  it("does not smuggle a stale warning into an unrelated write", async () => {
    // Guards against the warning being module state rather than per-call.
    const first = await writeQuickPage(ctxWith(true), "mimsy", mindDir, "One", "a", failingExec);
    const { exec } = recordingExec();
    const second = await writeQuickPage(ctxWith(true), "mimsy", mindDir, "Two", "b", exec);
    assert.ok(first.ownershipWarning);
    assert.equal(second.ownershipWarning, null);
  });
});

describe("a zero exit from chown is not proof the tree is the author's", () => {
  it("catches an ancestor nobody handed to chown", () => {
    // Reachable in the field: `addPagesWorktree` skips its recursive chown whenever
    // a `_system` worktree already exists, so `home/pages` can stay root-owned while
    // every later write reports success. The author is then told the page is theirs
    // while the directory holding it is not.
    //
    // `/etc/hosts` stands in for the root-owned ancestor; the temp file is the page.
    // Comparing against the file's own uid means no user lookup is needed.
    const mine = mkdtempSync(resolve(tmpdir(), "pages-own-verify-"));
    const page = resolve(mine, "page.md");
    writeFileSync(page, "x");
    try {
      const warning = verifyOwnership({ isIsolationEnabled: () => true }, "mimsy", [
        "/etc/hosts",
        page,
      ]);
      assert.ok(warning, "a half-owned tree must be reported");
      assert.match(warning, /\/etc\/hosts/);
      assert.match(warning, /mimsy/);
    } finally {
      rmSync(mine, { recursive: true, force: true });
    }
  });

  it("stays quiet on a consistently owned tree, and when isolation is off", () => {
    const mine = mkdtempSync(resolve(tmpdir(), "pages-own-verify-ok-"));
    const page = resolve(mine, "page.md");
    writeFileSync(page, "x");
    try {
      assert.equal(
        verifyOwnership({ isIsolationEnabled: () => true }, "mimsy", [mine, page]),
        null,
      );
      assert.equal(
        verifyOwnership({ isIsolationEnabled: () => false }, "mimsy", ["/etc/hosts", page]),
        null,
      );
    } finally {
      rmSync(mine, { recursive: true, force: true });
    }
  });
});

describe("the daemon refuses to be walked out of the pages directory", () => {
  let mindDir: string;
  let outside: string;

  beforeEach(() => {
    mindDir = mkdtempSync(resolve(tmpdir(), "pages-esc-mind-"));
    outside = mkdtempSync(resolve(tmpdir(), "pages-esc-out-"));
    mkdirSync(resolve(mindDir, "home", "pages"), { recursive: true });
  });
  afterEach(() => {
    rmSync(mindDir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("refuses a notes/ that is a symlink out of the pages directory", () => {
    // The mind owns home/pages under isolation, so it can do exactly this. The
    // string-prefix check this replaced passed happily: `resolve()` never touches
    // the filesystem, so the path looked contained while the write landed in
    // `outside` as root — and the chown would then have handed `outside` away.
    const pagesDir = resolve(mindDir, "home", "pages");
    symlinkSync(outside, resolve(pagesDir, "notes"));
    assert.throws(
      () => resolvePagesWrite(mindDir, resolve(pagesDir, "notes", "pwned.md")),
      /Refusing to write outside the pages directory/,
    );
  });

  it("refuses when home/pages itself is the symlink", () => {
    // The mind owns home/ too, so checking only the leg below pages/ is half a check.
    const other = mkdtempSync(resolve(tmpdir(), "pages-esc-alt-"));
    const alt = mkdtempSync(resolve(tmpdir(), "pages-esc-mind2-"));
    try {
      mkdirSync(resolve(alt, "home"), { recursive: true });
      mkdirSync(resolve(other, "notes"), { recursive: true });
      symlinkSync(other, resolve(alt, "home", "pages"));
      assert.throws(
        () => resolvePagesWrite(alt, resolve(alt, "home", "pages", "notes", "x.md")),
        /home\/pages resolves outside/,
      );
    } finally {
      rmSync(other, { recursive: true, force: true });
      rmSync(alt, { recursive: true, force: true });
    }
  });

  it("allows an ordinary write, and returns the real path to act on", () => {
    const pagesDir = resolve(mindDir, "home", "pages");
    mkdirSync(resolve(pagesDir, "notes"), { recursive: true });
    const target = resolve(pagesDir, "notes", "a.md");
    assert.equal(
      resolvePagesWrite(mindDir, target),
      resolve(realpathSync(resolve(pagesDir, "notes")), "a.md"),
    );
  });
});

describe("no second write path into a mind's home/pages", () => {
  it("keeps the command and route layers free of their own file writes", () => {
    // A regression guard for the "wired into 1 of 2 paths" class this PR fixes:
    // the chown lives inside writeQuickPage, so it only holds while writeQuickPage
    // is the single writer. A `writeFileSync` appearing in the command or route
    // layer is a page born root-owned again.
    const src = resolve(import.meta.dirname, "..", "packages", "extensions", "pages", "src");
    const writes = /\b(writeFileSync|appendFileSync|mkdirSync|cpSync|writeFile|appendFile)\(/;
    for (const file of ["routes.ts", "commands.ts"]) {
      const text = readFileSync(resolve(src, file), "utf-8");
      const hit = text.match(writes);
      assert.ok(
        !hit,
        `${file} writes to the filesystem directly (${hit?.[1]}) — route it through ` +
          "writeQuickPage so the result is chowned to its author",
      );
    }
  });
});
