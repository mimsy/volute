import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { eq, inArray } from "drizzle-orm";
import { createUser } from "../packages/daemon/src/lib/auth.js";
import {
  initMindManager,
  type MindManager,
  tryGetMindManager,
} from "../packages/daemon/src/lib/daemon/mind-manager.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  acquireJoinLock,
  describeJoinAge,
  JoinInProgressError,
  joinInProgress,
} from "../packages/daemon/src/lib/mind/join-lock.js";
import { minds, users } from "../packages/daemon/src/lib/schema.js";
import { createSession, deleteSession } from "../packages/daemon/src/web/middleware/auth.js";

// #655: three principals ran `join` against the same variant at once — the host via
// CLI, the parent mind via Bash, and the spirit — and all three proceeded. These cover
// the lock itself, then both entry points into a merge (the merge route and the
// mind-initiated merge restart), then a genuine two-request race.

const ADMIN = "jl-admin";
const PARENT = "jl-parent";
const VARIANT = "jl-variant";
const OTHER = "jl-other-parent";

const TEST_USERNAMES = [ADMIN];
const TEST_MIND_ROWS = [PARENT, VARIANT, OTHER];

const sessions: string[] = [];
const tempRoots: string[] = [];
/** Release functions for locks a test took directly, run even when it failed. */
const heldLocks: Array<() => void> = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

/**
 * A parent mind repo with a variant worktree, both registered so the real routes
 * resolve them. The parent's `app.txt` and the variant's uncommitted edit of the same
 * file are deliberate: the variant's edit forces mergeVariant's auto-commit (the first
 * thing a join does inside the lock), and the two edits then collide, so a join that
 * gets through fails at the merge rather than running on to spawn a real server.
 */
async function setupParentAndVariant(): Promise<{ baseDir: string; variantDir: string }> {
  const baseDir = mkdtempSync(resolve(tmpdir(), "jl-base-"));
  tempRoots.push(baseDir);

  git(baseDir, "init", "-q");
  git(baseDir, "config", "user.name", "t");
  git(baseDir, "config", "user.email", "t@t");
  git(baseDir, "config", "commit.gpgsign", "false");
  mkdirSync(resolve(baseDir, "home"), { recursive: true });
  // A stub node_modules keeps npmInstallNeeded from shelling out to `npm install`.
  mkdirSync(resolve(baseDir, "node_modules"), { recursive: true });
  writeFileSync(resolve(baseDir, "app.txt"), "v1\n");
  writeFileSync(resolve(baseDir, "home/MEMORY.md"), "parent memory\n");
  writeFileSync(resolve(baseDir, ".gitignore"), "node_modules/\n.variants/\n");
  git(baseDir, "add", "-A");
  git(baseDir, "commit", "-q", "-m", "initial");

  mkdirSync(resolve(baseDir, ".variants"), { recursive: true });
  const variantDir = resolve(baseDir, ".variants", VARIANT);
  git(baseDir, "worktree", "add", "-q", "-b", VARIANT, variantDir);

  // Parent and variant both edit app.txt; the variant's edit is left uncommitted.
  writeFileSync(resolve(baseDir, "app.txt"), "parent change\n");
  git(baseDir, "add", "-A");
  git(baseDir, "commit", "-q", "-m", "parent change");
  writeFileSync(resolve(variantDir, "app.txt"), "variant change\n");

  const db = await getDb();
  await db.insert(minds).values({ name: PARENT, port: 47311, dir: baseDir });
  await db
    .insert(minds)
    .values({ name: VARIANT, port: 47312, parent: PARENT, dir: variantDir, branch: VARIANT });

  return { baseDir, variantDir };
}

/**
 * Make every commit in this repo take ~1s, so a join that holds the lock is still
 * holding it when a second request arrives. Worktrees share the common dir's hooks,
 * so this covers the variant auto-commit too.
 */
function installSlowCommitHook(baseDir: string) {
  const hook = resolve(baseDir, ".git/hooks/pre-commit");
  writeFileSync(hook, "#!/bin/sh\nsleep 1\n");
  chmodSync(hook, 0o755);
}

async function makeAdmin(): Promise<string> {
  const user = await createUser(ADMIN, "pw-123456");
  const db = await getDb();
  await db.update(users).set({ role: "admin" }).where(eq(users.id, user.id));
  const sessionId = await createSession(user.id);
  sessions.push(sessionId);
  return sessionId;
}

function headers(cookie: string) {
  return {
    Cookie: `volute_session=${cookie}`,
    Origin: "http://localhost",
    "Content-Type": "application/json",
  };
}

async function post(path: string, cookie: string, body: unknown) {
  const { default: app } = await import("../packages/daemon/src/web/app.js");
  return app.request(`http://localhost${path}`, {
    method: "POST",
    headers: headers(cookie),
    body: JSON.stringify(body),
  });
}

async function del(path: string, cookie: string) {
  const { default: app } = await import("../packages/daemon/src/web/app.js");
  return app.request(`http://localhost${path}`, {
    method: "DELETE",
    headers: headers(cookie),
  });
}

function manager(): MindManager {
  return tryGetMindManager() ?? initMindManager();
}

async function cleanup() {
  for (const release of heldLocks.splice(0)) release();
  for (const id of sessions.splice(0)) await deleteSession(id);
  const db = await getDb();
  await db.delete(users).where(inArray(users.username, TEST_USERNAMES));
  // `minds.port` is UNIQUE, so a leaked row collides with the next run's insert.
  await db.delete(minds).where(inArray(minds.name, TEST_MIND_ROWS));
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
}

describe("join lock (#655)", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("refuses a second acquire and names the join already running", () => {
    heldLocks.push(acquireJoinLock(PARENT, VARIANT));
    assert.equal(joinInProgress(PARENT)?.variant, VARIANT);

    assert.throws(
      () => acquireJoinLock(PARENT, "some-other-variant"),
      (err: unknown) => {
        assert.ok(err instanceof JoinInProgressError);
        assert.equal(err.holder, VARIANT);
        assert.equal(err.parentName, PARENT);
        assert.match(err.message, new RegExp(`join of ${VARIANT} into ${PARENT}`));
        // The message has to be actionable for a mind, not a bare error.
        assert.match(err.message, /Wait for it/);
        assert.match(err.message, /restarts with the merge result/);
        return true;
      },
    );
  });

  // The lock has no timeout and mergeVariant's npm install has none either, so a join
  // CAN wedge until the daemon restarts. A message that only says "wait for it to
  // finish" would then be telling a mind to wait for something that will never land.
  it("reports the running join's age and names the wedged case", () => {
    const since = new Date(Date.now() - 95 * 60 * 1000);
    const err = new JoinInProgressError(PARENT, { variant: VARIANT, since });

    assert.equal(err.since, since);
    // Age is evidence a mind can judge for itself: a join that is moving vs one stuck.
    assert.match(err.message, /has been running since \d\d:\d\d \(1h35m\)/);
    assert.match(err.message, /wedged/);
    assert.match(err.message, /restart the daemon/);

    // Age units, driven off an injected `now` so the assertion isn't a clock race.
    const at = (ms: number) => describeJoinAge({ variant: VARIANT, since: new Date(0) }, ms);
    assert.match(at(45_000), /^since \d\d:\d\d \(45s\)$/);
    assert.match(at(8 * 60_000), /\(8m\)$/);
    assert.match(at(3 * 3600_000 + 7 * 60_000), /\(3h7m\)$/);
  });

  it("is keyed on the parent, so different parents never block each other", () => {
    heldLocks.push(acquireJoinLock(PARENT, VARIANT));
    heldLocks.push(acquireJoinLock(OTHER, "other-variant"));
    assert.equal(joinInProgress(OTHER)?.variant, "other-variant");
  });

  it("releases on success, on failure, and only once", async () => {
    const release = acquireJoinLock(PARENT, VARIANT);
    release();
    assert.equal(joinInProgress(PARENT), undefined);
    // A double release must not drop a lock someone else has since taken.
    const second = acquireJoinLock(PARENT, "later-variant");
    heldLocks.push(second);
    release();
    assert.equal(joinInProgress(PARENT)?.variant, "later-variant");
    second();

    // The shape both routes use: acquire, work, release in a `finally`. A join that
    // throws must not wedge its parent for the rest of the daemon's life.
    await assert.rejects(async () => {
      const release = acquireJoinLock(PARENT, VARIANT);
      try {
        throw new Error("join blew up");
      } finally {
        release();
      }
    }, /join blew up/);
    assert.equal(joinInProgress(PARENT), undefined, "a failed join must not wedge its parent");
  });

  it("merge route: a second join gets a 409 and the variant is left untouched", async () => {
    const { baseDir, variantDir } = await setupParentAndVariant();
    const cookie = await makeAdmin();
    heldLocks.push(acquireJoinLock(PARENT, VARIANT));

    const headBefore = git(baseDir, "rev-parse", "HEAD");
    const res = await post(`/api/v1/minds/${PARENT}/variants/${VARIANT}/merge`, cookie, {
      skipVerify: true,
    });

    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /has been running since \d\d:\d\d/);
    // Every refusal a mind reads must disclose the wedged case, not just say "wait".
    assert.match(body.error, /restart the daemon/);
    assert.match(body.error, new RegExp(VARIANT));

    // Nothing ran: no farewell turn, no auto-commit, no merge.
    assert.ok(existsSync(variantDir), "variant worktree must survive a refused join");
    assert.equal(git(baseDir, "rev-parse", "HEAD"), headBefore);
    assert.equal(git(variantDir, "status", "--porcelain"), "M app.txt");
  });

  it("restart route: a mind-initiated join gets a 409 and is not stopped", async () => {
    const { baseDir } = await setupParentAndVariant();
    const cookie = await makeAdmin();
    heldLocks.push(acquireJoinLock(PARENT, VARIANT));

    // Claim the parent is running. The lock sits *before* the stop, so this must come
    // back 409 with the mind untouched; if the guard were placed after the stop, the
    // request would tear down a running mind for a join it was never going to run.
    const mgr = manager();
    const realIsRunning = mgr.isRunning.bind(mgr);
    let stopAttempted = false;
    const realStopMind = mgr.stopMind.bind(mgr);
    mgr.isRunning = () => true;
    mgr.stopMind = async (name: string) => {
      stopAttempted = true;
      return realStopMind(name);
    };

    try {
      const headBefore = git(baseDir, "rev-parse", "HEAD");
      const res = await post(`/api/v1/minds/${PARENT}/restart`, cookie, {
        context: { type: "merge", name: VARIANT },
      });

      assert.equal(res.status, 409);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /has been running since \d\d:\d\d/);
      // Every refusal a mind reads must disclose the wedged case, not just say "wait".
      assert.match(body.error, /restart the daemon/);
      assert.equal(stopAttempted, false, "a refused join must leave the mind running");
      assert.equal(git(baseDir, "rev-parse", "HEAD"), headBefore);
    } finally {
      mgr.isRunning = realIsRunning;
      mgr.stopMind = realStopMind;
    }
  });

  it("delete route: refuses to remove a variant while a join holds the parent", async () => {
    const { variantDir } = await setupParentAndVariant();
    const cookie = await makeAdmin();
    heldLocks.push(acquireJoinLock(PARENT, VARIANT));

    const res = await del(`/api/v1/minds/${PARENT}/variants/${VARIANT}`, cookie);

    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /join of .* is running \(since \d\d:\d\d/);
    // Same disclosure on the advisory guards, in their own wording.
    assert.match(body.error, /daemon restart clears it/);
    // The whole point: the worktree the merge is reading from is still there.
    assert.ok(existsSync(variantDir));
  });

  // `volute mind delete <name>` hits DELETE /minds/:name, not the variant endpoint, and
  // both of its branches reach cleanupVariant — the second path into the same damage.
  it("mind delete route: refuses to delete the variant being joined", async () => {
    const { variantDir } = await setupParentAndVariant();
    const cookie = await makeAdmin();
    heldLocks.push(acquireJoinLock(PARENT, VARIANT));

    const res = await del(`/api/v1/minds/${VARIANT}`, cookie);

    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /is running \(since \d\d:\d\d/);
    // Same disclosure on the advisory guards, in their own wording.
    assert.match(body.error, /daemon restart clears it/);
    assert.ok(existsSync(variantDir));
  });

  it("mind delete route: refuses to delete the parent being joined into", async () => {
    const { baseDir, variantDir } = await setupParentAndVariant();
    const cookie = await makeAdmin();
    heldLocks.push(acquireJoinLock(PARENT, VARIANT));

    const res = await del(`/api/v1/minds/${PARENT}?force=true`, cookie);

    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /is running \(since \d\d:\d\d/);
    // Same disclosure on the advisory guards, in their own wording.
    assert.match(body.error, /daemon restart clears it/);
    assert.ok(existsSync(baseDir));
    assert.ok(existsSync(variantDir));
    const db = await getDb();
    assert.ok(await db.select().from(minds).where(eq(minds.name, PARENT)).get());
  });

  it("split route: refuses to branch a new variant off a parent mid-join", async () => {
    await setupParentAndVariant();
    const cookie = await makeAdmin();
    heldLocks.push(acquireJoinLock(PARENT, VARIANT));

    const res = await post(`/api/v1/minds/${PARENT}/variants`, cookie, {
      name: "jl-second-variant",
    });

    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /is running \(since \d\d:\d\d/);
    // Same disclosure on the advisory guards, in their own wording.
    assert.match(body.error, /daemon restart clears it/);

    const db = await getDb();
    const row = await db.select().from(minds).where(eq(minds.name, "jl-second-variant")).get();
    assert.equal(row, undefined, "no variant row may be created by a refused split");
  });

  it("two overlapping merge requests: exactly one proceeds, the other gets 409", async () => {
    const { baseDir, variantDir } = await setupParentAndVariant();
    const cookie = await makeAdmin();
    // The winner's first git write takes ~1s, so the loser lands inside the lock's hold.
    installSlowCommitHook(baseDir);

    const path = `/api/v1/minds/${PARENT}/variants/${VARIANT}/merge`;
    const [a, b] = await Promise.all([
      post(path, cookie, { skipVerify: true }),
      post(path, cookie, { skipVerify: true }),
    ]);

    const statuses = [a.status, b.status].sort();
    const refused = a.status === 409 ? a : b;
    const proceeded = a.status === 409 ? b : a;

    const refusedBody = (await refused.json()) as { error: string };
    assert.match(
      refusedBody.error,
      /has been running since \d\d:\d\d/,
      `expected one refusal, got ${JSON.stringify(statuses)}: ${refusedBody.error}`,
    );

    // The one that got through ran the real join and hit the seeded merge conflict —
    // proof it was not itself refused, and that it reached the merge the other was
    // blocked from racing.
    assert.notEqual(proceeded.status, 409);
    const proceededBody = (await proceeded.json()) as { error?: string };
    assert.match(String(proceededBody.error), /Merge failed\. Resolve conflicts/);

    // A blocked merge leaves the variant intact so the join can be retried.
    assert.ok(existsSync(variantDir));
    // Exactly one auto-commit happened: the winner's. A second, racing auto-commit
    // would have added another commit on the variant branch.
    assert.equal(git(baseDir, "rev-list", "--count", `HEAD..${VARIANT}`), "1");
  });
});
