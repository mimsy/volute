import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  addMind,
  addVariant,
  mindDir,
  removeMind,
} from "../packages/daemon/src/lib/mind/registry.js";
import { sessions, users } from "../packages/daemon/src/lib/schema.js";
import { exec } from "../packages/daemon/src/lib/util/exec.js";
import variantsApp from "../packages/daemon/src/web/api/variants.js";
import { type AuthEnv, authMiddleware } from "../packages/daemon/src/web/middleware/auth.js";
import { cleanGitEnv } from "./helpers/test-git-env.js";

// Runs in its own file so flipping VOLUTE_ISOLATION only affects this process
// (node runs each test file in a separate process). The `mind-<name>` OS user
// intentionally does not exist, so chownMindDir's real `chown` fails. The join's
// git runs as the mind (#961), so it hands the tree to the mind first — and a
// chown that can't do that must stop the join before any git touches the repo.

const parentName = `vjoin-iso-${Date.now()}`;
const variantName = `${parentName}-var`;
const branch = variantName;

let adminCookie: string;
let parentDir: string;
let variantDir: string;

const originalIsolation = process.env.VOLUTE_ISOLATION;

function createApp() {
  const app = new Hono<AuthEnv>();
  app.use("/*", authMiddleware);
  app.route("/minds", variantsApp);
  return app;
}

describe("failed variant join restores parent ownership under user isolation", () => {
  before(async () => {
    process.env.VOLUTE_ISOLATION = "user";
    const env = cleanGitEnv();

    parentDir = mindDir(parentName);
    variantDir = resolve(parentDir, ".variants", variantName);
    if (existsSync(parentDir)) rmSync(parentDir, { recursive: true, force: true });
    mkdirSync(parentDir, { recursive: true });

    // Parent repo with a tracked file that both sides will edit conflictingly.
    await exec("git", ["init"], { cwd: parentDir, env });
    await exec("git", ["config", "user.email", "test@test.com"], { cwd: parentDir, env });
    await exec("git", ["config", "user.name", "Test"], { cwd: parentDir, env });
    writeFileSync(resolve(parentDir, "MEMORY.md"), "base\n");
    await exec("git", ["add", "-A"], { cwd: parentDir, env });
    await exec("git", ["commit", "-m", "init"], { cwd: parentDir, env });

    // Variant worktree on its own branch, with a conflicting edit.
    await exec("git", ["worktree", "add", "-b", branch, variantDir], { cwd: parentDir, env });
    writeFileSync(resolve(variantDir, "MEMORY.md"), "variant version\n");
    await exec("git", ["commit", "-am", "variant edit"], { cwd: variantDir, env });

    // Parent (main) makes a conflicting edit to the same file.
    writeFileSync(resolve(parentDir, "MEMORY.md"), "parent version\n");
    await exec("git", ["commit", "-am", "parent edit"], { cwd: parentDir, env });

    await addMind(parentName, 4196);
    await addVariant(variantName, parentName, 4197, variantDir, branch);

    const db = await getDb();
    const [user] = await db
      .insert(users)
      .values({ username: "vjoin-iso-admin", password_hash: "x", role: "admin" })
      .returning();
    const sessionId = crypto.randomUUID();
    await db.insert(sessions).values({ id: sessionId, userId: user.id, createdAt: Date.now() });
    adminCookie = `volute_session=${sessionId}`;
  });

  after(async () => {
    if (originalIsolation === undefined) delete process.env.VOLUTE_ISOLATION;
    else process.env.VOLUTE_ISOLATION = originalIsolation;
    if (existsSync(variantDir)) rmSync(variantDir, { recursive: true, force: true });
    if (existsSync(parentDir)) rmSync(parentDir, { recursive: true, force: true });
    await removeMind(variantName);
    await removeMind(parentName);
    const db = await getDb();
    await db.delete(users).where(eq(users.username, "vjoin-iso-admin"));
  });

  it("refuses before any git runs when the tree can't be handed to the mind", async () => {
    const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: parentDir })).trim();
    const app = createApp();
    const res = await app.request(`/minds/${parentName}/variants/${variantName}/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ skipVerify: true }),
    });

    // The chown that hands the tree to the mind fails (no `mind-<name>` user), and
    // the join stops there: no merge was attempted, so nothing ran as anyone.
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /chown/i);
    assert.equal((await exec("git", ["rev-parse", "HEAD"], { cwd: parentDir })).trim(), head);
    assert.equal(existsSync(resolve(parentDir, ".git", "MERGE_HEAD")), false);
    assert.ok(existsSync(variantDir), "the variant must be left intact");
  });
});

// The main-worktree auto-commit would fail (a failing pre-commit hook), but with
// no mind user to run it as, the join must not reach it: the hook never runs, and
// least of all as the daemon.
const acParent = `vjoin-ac-${Date.now()}`;
const acVariant = `${acParent}-var`;

let acCookie: string;
let acParentDir: string;
let acVariantDir: string;

describe("failed auto-commit before merge restores ownership under user isolation", () => {
  before(async () => {
    process.env.VOLUTE_ISOLATION = "user";
    const env = cleanGitEnv();

    acParentDir = mindDir(acParent);
    acVariantDir = resolve(acParentDir, ".variants", acVariant);
    if (existsSync(acParentDir)) rmSync(acParentDir, { recursive: true, force: true });
    mkdirSync(acParentDir, { recursive: true });

    await exec("git", ["init"], { cwd: acParentDir, env });
    await exec("git", ["config", "user.email", "test@test.com"], { cwd: acParentDir, env });
    await exec("git", ["config", "user.name", "Test"], { cwd: acParentDir, env });
    writeFileSync(resolve(acParentDir, "MEMORY.md"), "base\n");
    await exec("git", ["add", "-A"], { cwd: acParentDir, env });
    await exec("git", ["commit", "-m", "init"], { cwd: acParentDir, env });

    // Variant worktree with no uncommitted changes, so the variant auto-commit
    // is skipped and the main auto-commit is the first git write reached.
    await exec("git", ["worktree", "add", "-b", acVariant, acVariantDir], {
      cwd: acParentDir,
      env,
    });

    // Uncommitted change in the parent so the main auto-commit runs, plus a
    // pre-commit hook that always fails so that commit throws.
    writeFileSync(resolve(acParentDir, "MEMORY.md"), "dirty\n");
    const hook = resolve(acParentDir, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);

    await addMind(acParent, 4198);
    await addVariant(acVariant, acParent, 4199, acVariantDir, acVariant);

    const db = await getDb();
    const [user] = await db
      .insert(users)
      .values({ username: "vjoin-ac-admin", password_hash: "x", role: "admin" })
      .returning();
    const sessionId = crypto.randomUUID();
    await db.insert(sessions).values({ id: sessionId, userId: user.id, createdAt: Date.now() });
    acCookie = `volute_session=${sessionId}`;
  });

  after(async () => {
    if (originalIsolation === undefined) delete process.env.VOLUTE_ISOLATION;
    else process.env.VOLUTE_ISOLATION = originalIsolation;
    if (existsSync(acVariantDir)) rmSync(acVariantDir, { recursive: true, force: true });
    if (existsSync(acParentDir)) rmSync(acParentDir, { recursive: true, force: true });
    await removeMind(acVariant);
    await removeMind(acParent);
    const db = await getDb();
    await db.delete(users).where(eq(users.username, "vjoin-ac-admin"));
  });

  it("never runs the mind's pre-commit hook when the tree can't be handed over", async () => {
    const app = createApp();
    const res = await app.request(`/minds/${acParent}/variants/${acVariant}/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: acCookie },
      body: JSON.stringify({ skipVerify: true }),
    });

    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /chown/i);
    assert.doesNotMatch(body.error, /auto-commit/i, "the auto-commit must not have been tried");
    assert.match(
      await exec("git", ["status", "--porcelain"], { cwd: acParentDir }),
      /^ M MEMORY\.md$/m,
      "the parent's uncommitted change must be left as it was",
    );
  });
});

// An *uncaught* throw past the first git write (here: the variant worktree dir
// exists but is not a git worktree, so the first `git status` throws). Such
// throws used to escape to Hono's generic 500 with no ownership restore; the
// merge body is now wrapped in one try/catch that routes them through the same
// restore path, so the absent-mind-user chown failure still surfaces.
const thParent = `vjoin-th-${Date.now()}`;
const thVariant = `${thParent}-var`;

let thCookie: string;
let thParentDir: string;
let thVariantDir: string;

describe("uncaught throw during merge restores ownership under user isolation", () => {
  before(async () => {
    process.env.VOLUTE_ISOLATION = "user";

    thParentDir = mindDir(thParent);
    thVariantDir = resolve(thParentDir, ".variants", thVariant);
    if (existsSync(thParentDir)) rmSync(thParentDir, { recursive: true, force: true });
    // Parent dir exists (chown target) and the variant dir exists but is a plain
    // directory, not a git worktree — so the handler's first `git status` throws.
    mkdirSync(thVariantDir, { recursive: true });

    await addMind(thParent, 4200);
    await addVariant(thVariant, thParent, 4201, thVariantDir, thVariant);

    const db = await getDb();
    const [user] = await db
      .insert(users)
      .values({ username: "vjoin-th-admin", password_hash: "x", role: "admin" })
      .returning();
    const sessionId = crypto.randomUUID();
    await db.insert(sessions).values({ id: sessionId, userId: user.id, createdAt: Date.now() });
    thCookie = `volute_session=${sessionId}`;
  });

  after(async () => {
    if (originalIsolation === undefined) delete process.env.VOLUTE_ISOLATION;
    else process.env.VOLUTE_ISOLATION = originalIsolation;
    if (existsSync(thParentDir)) rmSync(thParentDir, { recursive: true, force: true });
    await removeMind(thVariant);
    await removeMind(thParent);
    const db = await getDb();
    await db.delete(users).where(eq(users.username, "vjoin-th-admin"));
  });

  it("restores ownership when a git op throws unexpectedly", async () => {
    const app = createApp();
    const res = await app.request(`/minds/${thParent}/variants/${thVariant}/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: thCookie },
      body: JSON.stringify({ skipVerify: true }),
    });

    // The thrown "not a git repository" is caught by the merge-body try/catch,
    // which runs chownMindDir before the 500 — and that chown fails against the
    // absent mind user, proving the catch hands ownership back.
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /join failed/i);
    assert.match(body.error, /chown/i);
  });
});

// failAfterGitWrite's success branch: with isolation OFF, chownMindDir is a
// no-op that resolves, so the helper returns a plain 500 that still carries its
// `...extra` (the conflict list). The other tests only ever hit the chown-FAILS
// branch, so this pins the success path the structural try/catch now funnels
// through.
const okParent = `vjoin-ok-${Date.now()}`;
const okVariant = `${okParent}-var`;
const okBranch = okVariant;

let okCookie: string;
let okParentDir: string;
let okVariantDir: string;

describe("merge-conflict response preserves conflicts when ownership restore succeeds", () => {
  before(async () => {
    // Isolation OFF so chownMindDir resolves without touching anything.
    delete process.env.VOLUTE_ISOLATION;
    const env = cleanGitEnv();

    okParentDir = mindDir(okParent);
    okVariantDir = resolve(okParentDir, ".variants", okVariant);
    if (existsSync(okParentDir)) rmSync(okParentDir, { recursive: true, force: true });
    mkdirSync(okParentDir, { recursive: true });

    await exec("git", ["init"], { cwd: okParentDir, env });
    await exec("git", ["config", "user.email", "test@test.com"], { cwd: okParentDir, env });
    await exec("git", ["config", "user.name", "Test"], { cwd: okParentDir, env });
    writeFileSync(resolve(okParentDir, "MEMORY.md"), "base\n");
    await exec("git", ["add", "-A"], { cwd: okParentDir, env });
    await exec("git", ["commit", "-m", "init"], { cwd: okParentDir, env });

    await exec("git", ["worktree", "add", "-b", okBranch, okVariantDir], { cwd: okParentDir, env });
    writeFileSync(resolve(okVariantDir, "MEMORY.md"), "variant version\n");
    await exec("git", ["commit", "-am", "variant edit"], { cwd: okVariantDir, env });

    writeFileSync(resolve(okParentDir, "MEMORY.md"), "parent version\n");
    await exec("git", ["commit", "-am", "parent edit"], { cwd: okParentDir, env });

    await addMind(okParent, 4202);
    await addVariant(okVariant, okParent, 4203, okVariantDir, okBranch);

    const db = await getDb();
    const [user] = await db
      .insert(users)
      .values({ username: "vjoin-ok-admin", password_hash: "x", role: "admin" })
      .returning();
    const sessionId = crypto.randomUUID();
    await db.insert(sessions).values({ id: sessionId, userId: user.id, createdAt: Date.now() });
    okCookie = `volute_session=${sessionId}`;
  });

  after(async () => {
    if (originalIsolation === undefined) delete process.env.VOLUTE_ISOLATION;
    else process.env.VOLUTE_ISOLATION = originalIsolation;
    if (existsSync(okVariantDir)) rmSync(okVariantDir, { recursive: true, force: true });
    if (existsSync(okParentDir)) rmSync(okParentDir, { recursive: true, force: true });
    await removeMind(okVariant);
    await removeMind(okParent);
    const db = await getDb();
    await db.delete(users).where(eq(users.username, "vjoin-ok-admin"));
  });

  it("returns the conflict list on a plain 500 when the chown no-ops", async () => {
    const app = createApp();
    const res = await app.request(`/minds/${okParent}/variants/${okVariant}/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: okCookie },
      body: JSON.stringify({ skipVerify: true }),
    });

    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: string; conflicts?: string[] };
    // Success branch: no chown-failure suffix, and the conflict list survives.
    assert.doesNotMatch(body.error, /chown/i);
    assert.doesNotMatch(body.error, /ownership/i);
    assert.ok(
      body.conflicts?.includes("MEMORY.md"),
      `expected MEMORY.md in conflicts: ${JSON.stringify(body.conflicts)}`,
    );
  });
});
