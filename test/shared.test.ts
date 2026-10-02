import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import { afterEach, describe, it, type TestContext } from "node:test";
import { voluteHome } from "../packages/daemon/src/lib/mind/registry.js";
import { gitExec } from "../packages/daemon/src/lib/util/exec.js";
import { resolveRealWithinBase } from "../packages/daemon/src/lib/util/paths.js";
import {
  addPagesWorktree,
  ensurePagesRepo,
  hasUnpublishedSharedChanges,
  type IsolationInfo,
  pagesLog,
  pagesMerge,
  pagesPull,
  pagesPullAndMerge,
  pagesRepoDir,
  pagesStatus,
  REFUSALS,
  reclaimGitDir,
  removePagesWorktree,
  WORKTREE_GIT,
  worktreeGitDir,
} from "../packages/extensions/pages/src/shared-pages.js";
import { cleanGitEnv } from "./helpers/test-git-env.js";

// Use a test-specific data dir within the test VOLUTE_HOME
function testDataDir(): string {
  return resolve(voluteHome(), "test-pages-ext-data");
}

// Helper to create a fake mind directory with a git repo
async function createFakeMind(name: string): Promise<string> {
  const dir = resolve(voluteHome(), "minds", name);
  const homeDir = resolve(dir, "home");
  mkdirSync(homeDir, { recursive: true });
  const env = cleanGitEnv();
  await gitExec(["init"], { cwd: dir, env });
  await gitExec(["checkout", "-b", "main"], { cwd: dir, env });
  writeFileSync(resolve(homeDir, "SOUL.md"), "test");
  await gitExec(["add", "-A"], { cwd: dir, env });
  await gitExec(["commit", "-m", "init"], { cwd: dir, env });
  return dir;
}

describe("pages collaborative repo", () => {
  const dataDir = testDataDir();

  afterEach(async () => {
    // Clean up pages repo for fresh tests
    const dir = pagesRepoDir(dataDir);
    if (existsSync(dir)) {
      try {
        await gitExec(["worktree", "prune"], { cwd: dir });
      } catch {
        // ignore
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pagesRepoDir returns path under dataDir", () => {
    const dir = pagesRepoDir(dataDir);
    assert.ok(dir.endsWith("/repo"));
    assert.ok(dir.startsWith(dataDir));
  });

  it("ensurePagesRepo creates repo idempotently", async () => {
    await ensurePagesRepo(dataDir);
    assert.ok(existsSync(resolve(pagesRepoDir(dataDir), ".git")));

    // Calling again should not fail
    await ensurePagesRepo(dataDir);
    assert.ok(existsSync(resolve(pagesRepoDir(dataDir), ".git")));
  });

  it("ensurePagesRepo repairs a husk .git left by an interrupted init", async () => {
    // Simulate the state a killed `git init` leaves behind: a .git dir with only
    // a branches/ subdir, no HEAD/config/objects (the bardo failure mode).
    const repoDir = pagesRepoDir(dataDir);
    mkdirSync(resolve(repoDir, ".git", "branches"), { recursive: true });

    // Before repair, the husk is not a usable repo.
    await assert.rejects(gitExec(["rev-parse", "HEAD"], { cwd: repoDir }));

    // ensurePagesRepo should wipe the husk and re-initialize.
    await ensurePagesRepo(dataDir);
    await gitExec(["rev-parse", "HEAD"], { cwd: repoDir });

    // And a worktree can now be added on the repaired repo.
    const mindDir = await createFakeMind("test-pages-husk");
    await addPagesWorktree("test-pages-husk", mindDir, dataDir);
    assert.ok(existsSync(resolve(mindDir, "home", "pages", "_system")));

    await removePagesWorktree("test-pages-husk", mindDir, dataDir);
  });

  it("addPagesWorktree skips (no throw) when the repo is a husk", async () => {
    // A husk repo that ensurePagesRepo hasn't repaired yet: worktree-add must
    // not shell into it and must not throw — it leaves repair for next startup.
    const repoDir = pagesRepoDir(dataDir);
    mkdirSync(resolve(repoDir, ".git", "branches"), { recursive: true });

    const mindDir = await createFakeMind("test-pages-husk-skip");
    await addPagesWorktree("test-pages-husk-skip", mindDir, dataDir);
    assert.ok(!existsSync(resolve(mindDir, "home", "pages", "_system")));
  });

  it("ensurePagesRepo commits with its own identity, independent of host config", async () => {
    await ensurePagesRepo(dataDir);
    const repoDir = pagesRepoDir(dataDir);
    // The init commit's committer must be the built-in identity, not whatever
    // (if anything) the host's global git config provides.
    const committer = (
      await gitExec(["log", "-1", "--format=%cn <%ce>", "main"], { cwd: repoDir })
    ).trim();
    assert.equal(committer, "volute <volute@localhost>");
  });

  it("addPagesWorktree creates worktree on mind-named branch", async () => {
    await ensurePagesRepo(dataDir);
    const mindDir = await createFakeMind("test-pages-add");
    await addPagesWorktree("test-pages-add", mindDir, dataDir);

    const worktreePath = resolve(mindDir, "home", "pages", "_system");
    assert.ok(existsSync(worktreePath));

    // Verify branch name
    const branch = (await gitExec(["branch", "--show-current"], { cwd: worktreePath })).trim();
    assert.equal(branch, "test-pages-add");

    await removePagesWorktree("test-pages-add", mindDir, dataDir);
  });

  it("addPagesWorktree is idempotent", async () => {
    await ensurePagesRepo(dataDir);
    const mindDir = await createFakeMind("test-pages-idempotent");
    await addPagesWorktree("test-pages-idempotent", mindDir, dataDir);
    // Second call should not throw
    await addPagesWorktree("test-pages-idempotent", mindDir, dataDir);

    await removePagesWorktree("test-pages-idempotent", mindDir, dataDir);
  });

  it("removePagesWorktree cleans up", async () => {
    await ensurePagesRepo(dataDir);
    const mindDir = await createFakeMind("test-pages-remove");
    await addPagesWorktree("test-pages-remove", mindDir, dataDir);

    const worktreePath = resolve(mindDir, "home", "pages", "_system");
    assert.ok(existsSync(worktreePath));

    await removePagesWorktree("test-pages-remove", mindDir, dataDir);

    // Worktree dir should be gone
    assert.ok(!existsSync(worktreePath));

    // Branch should be gone
    try {
      await gitExec(["rev-parse", "--verify", "test-pages-remove"], {
        cwd: pagesRepoDir(dataDir),
      });
      assert.fail("Branch should have been deleted");
    } catch {
      // Expected — branch was deleted
    }
  });

  it("removePagesWorktree is safe when no worktree exists", async () => {
    await ensurePagesRepo(dataDir);
    const mindDir = await createFakeMind("test-pages-remove-noop");
    // Should not throw
    await removePagesWorktree("test-pages-remove-noop", mindDir, dataDir);
  });

  it("pagesMerge squash-merges to main", async () => {
    await ensurePagesRepo(dataDir);
    const mindDir = await createFakeMind("test-pages-merge");
    await addPagesWorktree("test-pages-merge", mindDir, dataDir);

    const worktreePath = resolve(mindDir, "home", "pages", "_system");

    // Create a file in the worktree
    writeFileSync(resolve(worktreePath, "index.html"), "<h1>Hello</h1>");

    const result = await pagesMerge("test-pages-merge", mindDir, dataDir, "Add index page");
    assert.ok(result.ok);

    // Verify the file is on main
    const mainContent = await gitExec(["show", "main:index.html"], { cwd: pagesRepoDir(dataDir) });
    assert.equal(mainContent, "<h1>Hello</h1>");

    // Verify mind's branch was reset to main
    const diff = (
      await gitExec(["diff", "main...test-pages-merge", "--stat"], { cwd: pagesRepoDir(dataDir) })
    ).trim();
    assert.equal(diff, "");

    await removePagesWorktree("test-pages-merge", mindDir, dataDir);
  });

  it("pagesMerge returns nothing-to-merge when no changes", async () => {
    await ensurePagesRepo(dataDir);
    const mindDir = await createFakeMind("test-pages-merge-empty");
    await addPagesWorktree("test-pages-merge-empty", mindDir, dataDir);

    const result = await pagesMerge("test-pages-merge-empty", mindDir, dataDir, "No changes");
    assert.ok(result.ok);
    assert.equal(result.message, "Nothing to publish");

    await removePagesWorktree("test-pages-merge-empty", mindDir, dataDir);
  });

  it("pagesMerge detects conflicts and aborts cleanly", async () => {
    await ensurePagesRepo(dataDir);

    const mindDirA = await createFakeMind("test-pages-conflict-a");
    const mindDirB = await createFakeMind("test-pages-conflict-b");
    await addPagesWorktree("test-pages-conflict-a", mindDirA, dataDir);
    await addPagesWorktree("test-pages-conflict-b", mindDirB, dataDir);

    const worktreeA = resolve(mindDirA, "home", "pages", "_system");
    const worktreeB = resolve(mindDirB, "home", "pages", "_system");

    // Both minds edit the same file differently
    writeFileSync(resolve(worktreeA, "conflict.txt"), "version A");
    writeFileSync(resolve(worktreeB, "conflict.txt"), "version B");

    // Mind A merges first — should succeed
    const resultA = await pagesMerge("test-pages-conflict-a", mindDirA, dataDir, "A's version");
    assert.ok(resultA.ok);

    // Mind B merges — should detect conflict
    const resultB = await pagesMerge("test-pages-conflict-b", mindDirB, dataDir, "B's version");
    assert.equal(resultB.ok, false);
    assert.equal(resultB.conflicts, true);

    // Verify main is clean (A's version persists)
    const mainContent = await gitExec(["show", "main:conflict.txt"], {
      cwd: pagesRepoDir(dataDir),
    });
    assert.equal(mainContent, "version A");

    await removePagesWorktree("test-pages-conflict-a", mindDirA, dataDir);
    await removePagesWorktree("test-pages-conflict-b", mindDirB, dataDir);
  });

  it("pagesPull with no changes is a no-op", async () => {
    await ensurePagesRepo(dataDir);
    const mindDir = await createFakeMind("test-pages-pull-noop");
    await addPagesWorktree("test-pages-pull-noop", mindDir, dataDir);

    const result = await pagesPull("test-pages-pull-noop", mindDir, dataDir);
    assert.ok(result.ok);

    await removePagesWorktree("test-pages-pull-noop", mindDir, dataDir);
  });

  it("pagesPull auto-commits dirty worktree before pulling", async () => {
    await ensurePagesRepo(dataDir);
    const mindDirA = await createFakeMind("test-pages-pull-dirty-a");
    const mindDirB = await createFakeMind("test-pages-pull-dirty-b");
    await addPagesWorktree("test-pages-pull-dirty-a", mindDirA, dataDir);
    await addPagesWorktree("test-pages-pull-dirty-b", mindDirB, dataDir);

    const worktreeA = resolve(mindDirA, "home", "pages", "_system");
    const worktreeB = resolve(mindDirB, "home", "pages", "_system");

    // Mind A creates a file and merges
    writeFileSync(resolve(worktreeA, "from-a.html"), "<p>from A</p>");
    await pagesMerge("test-pages-pull-dirty-a", mindDirA, dataDir, "A's page");

    // Mind B has uncommitted changes in a different file
    writeFileSync(resolve(worktreeB, "from-b.html"), "<p>from B</p>");

    // Mind B pulls — should auto-commit B's file and get A's file
    const result = await pagesPull("test-pages-pull-dirty-b", mindDirB, dataDir);
    assert.ok(result.ok);

    // Both files should exist
    assert.ok(existsSync(resolve(worktreeB, "from-a.html")));
    assert.equal(readFileSync(resolve(worktreeB, "from-b.html"), "utf-8"), "<p>from B</p>");

    await removePagesWorktree("test-pages-pull-dirty-a", mindDirA, dataDir);
    await removePagesWorktree("test-pages-pull-dirty-b", mindDirB, dataDir);
  });

  it("pagesPull gets changes from another mind", async () => {
    await ensurePagesRepo(dataDir);
    const mindDirA = await createFakeMind("test-pages-pull-a");
    const mindDirB = await createFakeMind("test-pages-pull-b");
    await addPagesWorktree("test-pages-pull-a", mindDirA, dataDir);
    await addPagesWorktree("test-pages-pull-b", mindDirB, dataDir);

    const worktreeA = resolve(mindDirA, "home", "pages", "_system");
    const worktreeB = resolve(mindDirB, "home", "pages", "_system");

    // Mind A creates a file and merges
    writeFileSync(resolve(worktreeA, "from-a.html"), "<p>from A</p>");
    await pagesMerge("test-pages-pull-a", mindDirA, dataDir, "A's page");

    // Mind B pulls — should get A's file
    const result = await pagesPull("test-pages-pull-b", mindDirB, dataDir);
    assert.ok(result.ok);

    const content = readFileSync(resolve(worktreeB, "from-a.html"), "utf-8");
    assert.equal(content, "<p>from A</p>");

    await removePagesWorktree("test-pages-pull-a", mindDirA, dataDir);
    await removePagesWorktree("test-pages-pull-b", mindDirB, dataDir);
  });

  it("pagesPull leaves a conflicted rebase stopped, and names the file", async () => {
    await ensurePagesRepo(dataDir);
    const mindDirA = await createFakeMind("test-pages-pull-conflict-a");
    const mindDirB = await createFakeMind("test-pages-pull-conflict-b");
    await addPagesWorktree("test-pages-pull-conflict-a", mindDirA, dataDir);
    await addPagesWorktree("test-pages-pull-conflict-b", mindDirB, dataDir);

    const worktreeA = resolve(mindDirA, "home", "pages", "_system");
    const worktreeB = resolve(mindDirB, "home", "pages", "_system");

    // Mind A edits and merges
    writeFileSync(resolve(worktreeA, "conflict.txt"), "version A");
    await pagesMerge("test-pages-pull-conflict-a", mindDirA, dataDir, "A's version");

    // Mind B edits the same file and commits
    writeFileSync(resolve(worktreeB, "conflict.txt"), "version B");
    await gitExec(["add", "-A"], { cwd: worktreeB });
    await gitExec(
      ["commit", "--author", "test-pages-pull-conflict-b <test@volute>", "-m", "B's version"],
      { cwd: worktreeB },
    );

    // Mind B pulls — should detect conflict
    const result = await pagesPull("test-pages-pull-conflict-b", mindDirB, dataDir);
    assert.equal(result.ok, false);
    assert.equal(result.conflicts, true);
    assert.match(result.message ?? "", /conflict in pages\/_system: conflict\.txt/);

    // Stopped, not aborted: there is something to resolve, as the message says (#1330).
    const status = await gitExec(["status"], { cwd: worktreeB });
    assert.match(status, /rebasing branch 'test-pages-pull-conflict-b'/);

    await removePagesWorktree("test-pages-pull-conflict-a", mindDirA, dataDir);
    await removePagesWorktree("test-pages-pull-conflict-b", mindDirB, dataDir);
  });

  it("pagesStatus shows file status", async () => {
    await ensurePagesRepo(dataDir);
    const mindDir = await createFakeMind("test-pages-status");
    await addPagesWorktree("test-pages-status", mindDir, dataDir);

    const worktreePath = resolve(mindDir, "home", "pages", "_system");

    // No HTML files — should show no pages
    let status = await pagesStatus("test-pages-status", mindDir, dataDir);
    assert.equal(status, "No shared pages found.");

    // Make a change and commit — should show as draft
    writeFileSync(resolve(worktreePath, "new.html"), "<p>new</p>");
    await gitExec(["add", "-A"], { cwd: worktreePath });
    await gitExec(["commit", "--author", "test-pages-status <test@volute>", "-m", "add page"], {
      cwd: worktreePath,
    });

    status = await pagesStatus("test-pages-status", mindDir, dataDir);
    assert.ok(status.includes("new.html"));
    assert.ok(status.includes("draft"));

    // Merge to main — should show as published
    await pagesMerge("test-pages-status", mindDir, dataDir, "publish");
    status = await pagesStatus("test-pages-status", mindDir, dataDir);
    assert.ok(status.includes("new.html"));
    assert.ok(status.includes("published"));

    await removePagesWorktree("test-pages-status", mindDir, dataDir);
  });

  it("pagesLog shows commit history", async () => {
    await ensurePagesRepo(dataDir);
    const mindDir = await createFakeMind("test-pages-log");
    await addPagesWorktree("test-pages-log", mindDir, dataDir);

    const worktreePath = resolve(mindDir, "home", "pages", "_system");

    // Initial log should have at least the init commit
    let log = await pagesLog(dataDir, 10);
    assert.ok(log.includes("init pages repo"));

    // Merge a change and check log
    writeFileSync(resolve(worktreePath, "index.html"), "<h1>Hi</h1>");
    await pagesMerge("test-pages-log", mindDir, dataDir, "Add index page");

    log = await pagesLog(dataDir, 10);
    assert.ok(log.includes("Add index page"));

    await removePagesWorktree("test-pages-log", mindDir, dataDir);
  });

  it("pagesPullAndMerge publishes changes atomically", async () => {
    await ensurePagesRepo(dataDir);
    const mindDir = await createFakeMind("test-pam-happy");
    await addPagesWorktree("test-pam-happy", mindDir, dataDir);

    const worktreePath = resolve(mindDir, "home", "pages", "_system");
    writeFileSync(resolve(worktreePath, "index.html"), "<h1>Hello</h1>");

    const result = await pagesPullAndMerge("test-pam-happy", mindDir, dataDir, "Add index page");
    assert.ok(result.ok);

    // Verify the file is on main
    const mainContent = await gitExec(["show", "main:index.html"], { cwd: pagesRepoDir(dataDir) });
    assert.equal(mainContent, "<h1>Hello</h1>");

    // Verify mind's branch was reset to main
    const diff = (
      await gitExec(["diff", "main...test-pam-happy", "--stat"], { cwd: pagesRepoDir(dataDir) })
    ).trim();
    assert.equal(diff, "");

    await removePagesWorktree("test-pam-happy", mindDir, dataDir);
  });

  // #1095: `git add -A` runs as the daemon (root under isolation) and commits a
  // hard link by content, so a planted link to an unreadable file would be
  // laundered into an ordinary page. Every commit path must refuse it.
  for (const [label, run] of [
    [
      "pagesMerge",
      (name: string, mindDir: string) => pagesMerge(name, mindDir, testDataDir(), "leak"),
    ],
    ["pagesPull", (name: string, mindDir: string) => pagesPull(name, mindDir, dataDir)],
    [
      "pagesPullAndMerge",
      (name: string, mindDir: string) => pagesPullAndMerge(name, mindDir, testDataDir(), "leak"),
    ],
  ] as const) {
    for (const rel of ["leak.md", "deep/nested/leak.md"]) {
      it(`${label} refuses a hard-linked file (${rel}) and commits nothing`, async () => {
        await ensurePagesRepo(dataDir);
        const name = `test-hardlink-${label}-${rel.includes("/") ? "nested" : "top"}`.toLowerCase();
        const mindDir = await createFakeMind(name);
        await addPagesWorktree(name, mindDir, dataDir);
        const wt = resolve(mindDir, "home", "pages", "_system");
        const repo = pagesRepoDir(dataDir);

        // Stands in for a root-only file such as secrets.json: outside the worktree.
        const secret = resolve(mindDir, "secret.json");
        writeFileSync(secret, '{"key":"sk-secret"}');
        mkdirSync(resolve(wt, rel, ".."), { recursive: true });
        linkSync(secret, resolve(wt, rel));
        writeFileSync(resolve(wt, "ordinary.md"), "fine");

        const mainBefore = (await gitExec(["rev-parse", "main"], { cwd: repo })).trim();
        const branchBefore = (await gitExec(["rev-parse", "HEAD"], { cwd: wt })).trim();

        const result = await run(name, mindDir);
        assert.equal(result.ok, false);
        assert.ok(result.message?.includes(rel), result.message);
        assert.ok(result.message?.includes("hard link"), result.message);

        assert.equal((await gitExec(["rev-parse", "main"], { cwd: repo })).trim(), mainBefore);
        assert.equal((await gitExec(["rev-parse", "HEAD"], { cwd: wt })).trim(), branchBefore);
        // Not even staged: the index holds nothing new.
        const staged = (await gitExec(["diff", "--cached", "--name-only"], { cwd: wt })).trim();
        assert.equal(staged, "");

        await removePagesWorktree(name, mindDir, dataDir);
      });
    }
  }

  it("pagesPullAndMerge refuses a tracked page replaced by a hard link", async () => {
    await ensurePagesRepo(dataDir);
    const name = "test-hardlink-tracked";
    const mindDir = await createFakeMind(name);
    await addPagesWorktree(name, mindDir, dataDir);
    const wt = resolve(mindDir, "home", "pages", "_system");
    writeFileSync(resolve(wt, "page.md"), "original");
    assert.ok((await pagesPullAndMerge(name, mindDir, dataDir, "add page")).ok);

    const secret = resolve(mindDir, "secret.json");
    writeFileSync(secret, '{"key":"sk-secret"}');
    rmSync(resolve(wt, "page.md"));
    linkSync(secret, resolve(wt, "page.md"));

    const result = await pagesPullAndMerge(name, mindDir, dataDir, "leak");
    assert.equal(result.ok, false);
    assert.ok(result.message?.includes("page.md"), result.message);
    const onMain = await gitExec(["show", "main:page.md"], { cwd: pagesRepoDir(dataDir) });
    assert.equal(onMain, "original");

    await removePagesWorktree(name, mindDir, dataDir);
  });

  it("a hard link in a gitignored path does not block publishing", async () => {
    await ensurePagesRepo(dataDir);
    const name = "test-hardlink-ignored";
    const mindDir = await createFakeMind(name);
    await addPagesWorktree(name, mindDir, dataDir);
    const wt = resolve(mindDir, "home", "pages", "_system");
    writeFileSync(resolve(wt, ".gitignore"), "node_modules/\n");
    mkdirSync(resolve(wt, "node_modules"));
    const store = resolve(mindDir, "store.js");
    writeFileSync(store, "module.exports = 1;");
    linkSync(store, resolve(wt, "node_modules", "dep.js"));
    writeFileSync(resolve(wt, "index.md"), "hello");

    const result = await pagesPullAndMerge(name, mindDir, dataDir, "publish");
    assert.ok(result.ok, result.message);
    const onMain = await gitExec(["show", "main:index.md"], { cwd: pagesRepoDir(dataDir) });
    assert.equal(onMain, "hello");

    await removePagesWorktree(name, mindDir, dataDir);
  });

  it("a symlink in the worktree is not refused (git stores it as a path)", async () => {
    await ensurePagesRepo(dataDir);
    const name = "test-hardlink-symlink-ok";
    const mindDir = await createFakeMind(name);
    await addPagesWorktree(name, mindDir, dataDir);
    const wt = resolve(mindDir, "home", "pages", "_system");
    const { symlinkSync } = await import("node:fs");
    symlinkSync("/nonexistent/target", resolve(wt, "link.md"));

    const result = await pagesPullAndMerge(name, mindDir, dataDir, "symlink");
    assert.ok(result.ok, result.message);

    await removePagesWorktree(name, mindDir, dataDir);
  });

  it("pagesPullAndMerge returns nothing-to-publish when no changes", async () => {
    await ensurePagesRepo(dataDir);
    const mindDir = await createFakeMind("test-pam-noop");
    await addPagesWorktree("test-pam-noop", mindDir, dataDir);

    const result = await pagesPullAndMerge("test-pam-noop", mindDir, dataDir, "No changes");
    assert.ok(result.ok);
    assert.equal(result.message, "Nothing to publish");

    await removePagesWorktree("test-pam-noop", mindDir, dataDir);
  });

  it("pagesPullAndMerge leaves a conflicted rebase stopped, and publishes nothing", async () => {
    await ensurePagesRepo(dataDir);
    const mindDirA = await createFakeMind("test-pam-conflict-a");
    const mindDirB = await createFakeMind("test-pam-conflict-b");
    await addPagesWorktree("test-pam-conflict-a", mindDirA, dataDir);
    await addPagesWorktree("test-pam-conflict-b", mindDirB, dataDir);

    const worktreeA = resolve(mindDirA, "home", "pages", "_system");
    const worktreeB = resolve(mindDirB, "home", "pages", "_system");

    // Mind A publishes first
    writeFileSync(resolve(worktreeA, "conflict.txt"), "version A");
    await pagesPullAndMerge("test-pam-conflict-a", mindDirA, dataDir, "A's version");

    // Mind B has conflicting changes committed
    writeFileSync(resolve(worktreeB, "conflict.txt"), "version B");
    await gitExec(["add", "-A"], { cwd: worktreeB });
    await gitExec(
      ["commit", "--author", "test-pam-conflict-b <test@volute>", "-m", "B's version"],
      { cwd: worktreeB },
    );

    // Mind B tries to publish — should detect conflict during pull
    const result = await pagesPullAndMerge("test-pam-conflict-b", mindDirB, dataDir, "B's version");
    assert.equal(result.ok, false);
    assert.equal(result.conflicts, true);
    assert.match(result.message ?? "", /conflict in pages\/_system: conflict\.txt/);
    const status = await gitExec(["status"], { cwd: worktreeB });
    assert.match(status, /rebasing branch 'test-pam-conflict-b'/);
    const main = await gitExec(["show", "main:conflict.txt"], { cwd: pagesRepoDir(dataDir) });
    assert.equal(main, "version A");

    await removePagesWorktree("test-pam-conflict-a", mindDirA, dataDir);
    await removePagesWorktree("test-pam-conflict-b", mindDirB, dataDir);
  });

  it("pagesPullAndMerge auto-commits dirty worktree", async () => {
    await ensurePagesRepo(dataDir);
    const mindDir = await createFakeMind("test-pam-dirty");
    await addPagesWorktree("test-pam-dirty", mindDir, dataDir);

    const worktreePath = resolve(mindDir, "home", "pages", "_system");

    // Leave file uncommitted
    writeFileSync(resolve(worktreePath, "draft.html"), "<p>draft</p>");

    const result = await pagesPullAndMerge("test-pam-dirty", mindDir, dataDir, "Publish draft");
    assert.ok(result.ok);

    // Verify file made it to main
    const mainContent = await gitExec(["show", "main:draft.html"], { cwd: pagesRepoDir(dataDir) });
    assert.equal(mainContent, "<p>draft</p>");

    await removePagesWorktree("test-pam-dirty", mindDir, dataDir);
  });

  // #1248/#1285: under isolation the daemon is root and the mind owns home/ and
  // home/pages, so it can swap either for a symlink into another mind's pages. Every
  // path root writes or runs git in must be contained first.
  function refusingIsolation() {
    const contained: string[] = [];
    const isolation: IsolationInfo = {
      isIsolationEnabled: () => true,
      getMindUser: (name) => `mind-${name}`,
      containMindPath: async (_name, path) => {
        contained.push(path);
        throw new Error("refused");
      },
      wrapForIsolation: async (cmd, args) => [cmd, args],
    };
    return { contained, isolation };
  }

  /**
   * Isolation with real containment (each mind's dir is its base) and a recording
   * stand-in for the uid switch: a test can't change uid, so `wrapForIsolation` notes
   * which git calls would have run as the mind.
   */
  function containingIsolation(gitConfig: string[] = [], env: string[] = []) {
    const asMind: { mind: string; args: string[] }[] = [];
    const isolation: IsolationInfo = {
      isIsolationEnabled: () => true,
      getMindUser: (name) => `mind-${name}`,
      containMindPath: async (name, path) => {
        // Callers pass both the path they built and real paths containment returned.
        const base = resolve(voluteHome(), "minds", name);
        const realBase = realpathSync(base);
        const from = path.startsWith(realBase + sep) ? realBase : base;
        return resolveRealWithinBase(base, relative(from, path));
      },
      wrapForIsolation: async (cmd, args, mind) => {
        asMind.push({ mind, args });
        return ["env", [`PAGES_GIT_AS=${mind}`, ...env, cmd, ...gitConfig, ...args]];
      },
    };
    return { asMind, isolation };
  }

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, env: cleanGitEnv(), encoding: "utf-8" }).trim();

  it("contains home before root creates anything in it on add", async (t) => {
    t.mock.method(console, "warn", () => {});
    await ensurePagesRepo(dataDir);
    const name = "test-pages-contain-add";
    const mindDir = await createFakeMind(name);
    const { contained, isolation } = refusingIsolation();
    await addPagesWorktree(name, mindDir, dataDir, isolation);
    assert.deepEqual(contained, [resolve(mindDir, "home")]);
    assert.equal(existsSync(resolve(mindDir, "home", "pages")), false);
  });

  it("does not provision a worktree through a swapped home/pages", async (t) => {
    t.mock.method(console, "warn", () => {});
    await ensurePagesRepo(dataDir);
    const a = await createFakeMind("test-pages-swap-add-a");
    const b = await createFakeMind("test-pages-swap-add-b");
    // The live shape: A's home/pages points into B's tree, where no _system exists yet.
    symlinkSync(resolve(b, "home"), resolve(a, "home", "pages"));
    const { isolation } = containingIsolation();
    await addPagesWorktree("test-pages-swap-add-a", a, dataDir, isolation);
    assert.equal(existsSync(resolve(b, "home", "_system")), false);
    assert.doesNotMatch(git(pagesRepoDir(dataDir), "worktree", "list"), /test-pages-swap-add-a/);
  });

  for (const [label, run] of [
    [
      "pagesMerge",
      (n: string, m: string, iso: IsolationInfo) => pagesMerge(n, m, dataDir, "x", iso),
    ],
    ["pagesPull", (n: string, m: string, iso: IsolationInfo) => pagesPull(n, m, dataDir, iso)],
    [
      "pagesPullAndMerge",
      (n: string, m: string, iso: IsolationInfo) => pagesPullAndMerge(n, m, dataDir, "x", iso),
    ],
  ] as const) {
    it(`${label} refuses a worktree containment refuses, and runs no git in it`, async (t) => {
      t.mock.method(console, "warn", () => {});
      await ensurePagesRepo(dataDir);
      const name = `test-pages-contain-${label.toLowerCase()}`;
      const mindDir = await createFakeMind(name);
      await addPagesWorktree(name, mindDir, dataDir);
      const wt = resolve(mindDir, "home", "pages", "_system");
      writeFileSync(resolve(wt, "page.html"), "<p>hi</p>");
      const { contained, isolation } = refusingIsolation();
      const result = await run(name, mindDir, isolation);
      assert.equal(result.ok, false);
      assert.match(result.message ?? "", /pages\/_system can't be used/);
      assert.deepEqual(contained, [wt]);
      assert.equal(git(wt, "status", "--porcelain"), "?? page.html");
      await removePagesWorktree(name, mindDir, dataDir);
    });

    it(`${label} does not act in another mind's worktree through a swapped home/pages`, async (t) => {
      t.mock.method(console, "warn", () => {});
      await ensurePagesRepo(dataDir);
      const tag = label.toLowerCase();
      const [nameA, nameB] = [`test-pages-swap-${tag}-a`, `test-pages-swap-${tag}-b`];
      const a = await createFakeMind(nameA);
      const b = await createFakeMind(nameB);
      await addPagesWorktree(nameA, a, dataDir);
      await addPagesWorktree(nameB, b, dataDir);
      const wtB = resolve(b, "home", "pages", "_system");
      writeFileSync(resolve(wtB, "draft.html"), "<p>B's draft</p>");
      const repo = pagesRepoDir(dataDir);
      const [tipB, tipMain] = [git(repo, "rev-parse", nameB), git(repo, "rev-parse", "main")];

      rmSync(resolve(a, "home", "pages"), { recursive: true, force: true });
      symlinkSync(resolve(b, "home", "pages"), resolve(a, "home", "pages"));
      const { isolation } = containingIsolation();
      const result = await run(nameA, a, isolation);

      assert.equal(result.ok, false);
      assert.equal(git(wtB, "status", "--porcelain"), "?? draft.html");
      assert.equal(git(repo, "rev-parse", nameB), tipB);
      assert.equal(git(repo, "rev-parse", "main"), tipMain);
    });
  }

  it("does not remove another mind's worktree through a swapped home/pages", async (t) => {
    t.mock.method(console, "warn", () => {});
    await ensurePagesRepo(dataDir);
    const a = await createFakeMind("test-pages-swap-remove-a");
    const b = await createFakeMind("test-pages-swap-remove-b");
    await addPagesWorktree("test-pages-swap-remove-a", a, dataDir);
    await addPagesWorktree("test-pages-swap-remove-b", b, dataDir);
    rmSync(resolve(a, "home", "pages"), { recursive: true, force: true });
    symlinkSync(resolve(b, "home", "pages"), resolve(a, "home", "pages"));
    const { isolation } = containingIsolation();
    await removePagesWorktree("test-pages-swap-remove-a", a, dataDir, isolation);
    assert.ok(existsSync(resolve(b, "home", "pages", "_system", ".git")));
  });

  it("rebases as the mind onto a main that moved, with no identity of its own", async (t) => {
    t.mock.method(console, "warn", () => {});
    await ensurePagesRepo(dataDir);
    const [nameA, nameB] = ["test-pages-rebase-id-a", "test-pages-rebase-id-b"];
    const a = await createFakeMind(nameA);
    const b = await createFakeMind(nameB);
    await addPagesWorktree(nameA, a, dataDir);
    await addPagesWorktree(nameB, b, dataDir);
    writeFileSync(resolve(b, "home", "pages", "_system", "b.md"), "# B\n");
    assert.ok((await pagesPullAndMerge(nameB, b, dataDir, "b")).ok);

    // A's work is committed on its branch, so the rebase has a commit to replay. A
    // mind's HOME carries no git identity, and a container's hostname has no domain
    // to guess an email from: no guessing at all stands in for both.
    writeFileSync(resolve(a, "home", "pages", "_system", "a.md"), "# A\n");
    const { isolation } = containingIsolation(
      ["-c", "user.useConfigOnly=true"],
      ["XDG_CONFIG_HOME=/nonexistent", "GIT_CONFIG_NOSYSTEM=1"],
    );
    const result = await pagesPullAndMerge(nameA, a, dataDir, "a", isolation);
    assert.ok(result.ok, JSON.stringify(result));
  });

  /**
   * The mind owns its gitdir, so it can point `commondir` at a repo whose config
   * defines a filter, and name that filter from its worktree (#1357). Returns the
   * marker the filter writes to when it runs.
   */
  function redirectCommondir(name: string, gitDir: string, wt: string): string {
    const decoy = resolve(voluteHome(), `${name}-decoy`);
    rmSync(decoy, { recursive: true, force: true });
    mkdirSync(decoy, { recursive: true });
    git(decoy, "init", "-q");
    const marker = resolve(voluteHome(), `${name}-ran`);
    rmSync(marker, { force: true });
    const filter = resolve(decoy, "probe");
    writeFileSync(filter, `#!/bin/sh\necho "as=[$PAGES_GIT_AS]" >> "${marker}"\ncat\n`, {
      mode: 0o755,
    });
    git(decoy, "config", "filter.probe.clean", filter);
    git(decoy, "config", "filter.probe.smudge", filter);
    writeFileSync(resolve(gitDir, "commondir"), resolve(decoy, ".git"));
    writeFileSync(resolve(wt, ".gitattributes"), "*.md filter=probe\n");
    writeFileSync(resolve(wt, "lore.md"), "# Lore\n");
    return marker;
  }

  for (const isolated of [false, true]) {
    it(`refuses a worktree whose commondir was redirected (${isolated ? "user" : "no"} isolation)`, async (t) => {
      t.mock.method(console, "warn", () => {});
      t.mock.method(console, "error", () => {});
      await ensurePagesRepo(dataDir);
      const name = `test-pages-commondir-${isolated ? "iso" : "plain"}`;
      const mindDir = await createFakeMind(name);
      await addPagesWorktree(name, mindDir, dataDir);
      const wt = resolve(mindDir, "home", "pages", "_system");
      const gitDir = worktreeGitDir(pagesRepoDir(dataDir), wt)!;
      const marker = redirectCommondir(name, gitDir, wt);
      assert.equal(worktreeGitDir(pagesRepoDir(dataDir), wt), null);

      const isolation = isolated ? containingIsolation().isolation : undefined;
      assert.deepEqual(
        await pagesPull(name, mindDir, dataDir, isolation),
        REFUSALS.UNVERIFIED_WORKTREE,
      );
      assert.deepEqual(
        await pagesPullAndMerge(name, mindDir, dataDir, "m", isolation),
        REFUSALS.UNVERIFIED_WORKTREE,
      );
      await assert.rejects(pagesStatus(name, mindDir, dataDir, isolation));
      assert.equal(await hasUnpublishedSharedChanges(name, mindDir, dataDir, isolation), false);
      assert.equal(existsSync(marker), false, "the planted filter ran");
    });
  }

  it("pins daemon git to the repo, whatever commondir says after vouching", async (t) => {
    t.mock.method(console, "warn", () => {});
    await ensurePagesRepo(dataDir);
    const name = "test-pages-commondir-pin";
    const mindDir = await createFakeMind(name);
    await addPagesWorktree(name, mindDir, dataDir);
    const wt = resolve(mindDir, "home", "pages", "_system");
    const repo = pagesRepoDir(dataDir);
    const gitDir = worktreeGitDir(repo, wt)!;
    // Vouched first, then redirected: the window between the check and the git run.
    const opts = await WORKTREE_GIT.mindWorktree(name, mindDir, repo);
    const marker = redirectCommondir(name, gitDir, wt);

    const common = await WORKTREE_GIT.gitExec(["rev-parse", "--git-common-dir"], opts);
    assert.equal(realpathSync(resolve(wt, common.trim())), realpathSync(resolve(repo, ".git")));
    await WORKTREE_GIT.gitExec(["add", "-A"], opts);
    await WORKTREE_GIT.gitExec(["status", "--porcelain"], opts);
    assert.equal(existsSync(marker), false, "the planted filter ran as the daemon");
    assert.match(await WORKTREE_GIT.gitExec(["diff", "--cached", "--name-only"], opts), /lore\.md/);
  });

  it("keeps the repo's config, hooks and info out of the minds' group", async (t) => {
    t.mock.method(console, "warn", () => {});
    await ensurePagesRepo(dataDir);
    const repo = pagesRepoDir(dataDir);
    const gitDir = resolve(repo, ".git");
    // A mind's worktree already in the repo, with work to publish after the repair.
    const name = "test-pages-harden-live";
    const mindDir = await createFakeMind(name);
    await addPagesWorktree(name, mindDir, dataDir);
    const head = git(repo, "rev-parse", "main");
    // What `init --shared=group` leaves, plus what a mind could have planted.
    chmodSync(repo, 0o2775);
    chmodSync(gitDir, 0o2775);
    chmodSync(resolve(gitDir, "config"), 0o664);
    chmodSync(resolve(gitDir, "hooks"), 0o2775);
    writeFileSync(resolve(gitDir, "info", "attributes"), "*.md filter=probe\n", { mode: 0o664 });
    symlinkSync("/bin/sh", resolve(gitDir, "hooks", "post-merge"));
    writeFileSync(resolve(gitDir, "hooks", "pre-commit"), "#!/bin/sh\n", { mode: 0o775 });

    await ensurePagesRepo(dataDir);

    // Permission bits only: setgid needs root wherever the group isn't the test user's.
    const mode = (p: string) => statSync(p).mode & 0o777;
    for (const d of [
      repo,
      gitDir,
      ...["hooks", "info", "worktrees"].map((d) => resolve(gitDir, d)),
    ]) {
      assert.equal(mode(d), 0o755, d);
    }
    assert.equal(mode(resolve(gitDir, "config")), 0o644);
    assert.equal(mode(resolve(gitDir, "HEAD")), 0o644);
    assert.equal(mode(resolve(gitDir, "info", "exclude")), 0o644);
    assert.equal(existsSync(resolve(gitDir, "info", "attributes")), false);
    assert.deepEqual(readdirSync(resolve(gitDir, "hooks")), []);
    assert.equal(git(repo, "rev-parse", "main"), head, "a repair, not a re-init");

    writeFileSync(resolve(mindDir, "home", "pages", "_system", "after.md"), "# After\n");
    const result = await pagesPullAndMerge(name, mindDir, dataDir, "after");
    assert.ok(result.ok, JSON.stringify(result));
  });

  it("removes a hard-linked info/exclude rather than keeping it", async () => {
    await ensurePagesRepo(dataDir);
    const exclude = resolve(pagesRepoDir(dataDir), ".git", "info", "exclude");
    const other = resolve(voluteHome(), "test-pages-exclude-other-name");
    rmSync(other, { force: true });
    linkSync(exclude, other);
    await ensurePagesRepo(dataDir);
    assert.equal(existsSync(exclude), false);
  });

  it("a filter one mind planted in the shared config doesn't run as another", async (t) => {
    t.mock.method(console, "warn", () => {});
    await ensurePagesRepo(dataDir);
    const repo = pagesRepoDir(dataDir);
    // Mind A, while the config was still group-writable: a filter for every page.
    const marker = resolve(voluteHome(), "test-pages-cross-mind-ran");
    rmSync(marker, { force: true });
    const filter = resolve(voluteHome(), "test-pages-cross-mind-filter");
    writeFileSync(filter, `#!/bin/sh\necho "as=[$PAGES_GIT_AS]" >> "${marker}"\ncat\n`, {
      mode: 0o755,
    });
    git(repo, "config", "filter.probe.clean", filter);
    git(repo, "config", "include.path", resolve(voluteHome(), "test-pages-cross-mind-include"));
    // Pointing at itself, so the repo stays valid and is repaired, not re-initialized.
    writeFileSync(resolve(repo, ".git", "commondir"), ".");

    await ensurePagesRepo(dataDir); // the next daemon start
    assert.doesNotMatch(readFileSync(resolve(repo, ".git", "config"), "utf-8"), /filter|include/);
    assert.equal(existsSync(resolve(repo, ".git", "commondir")), false);

    const nameB = "test-pages-cross-mind-b";
    const b = await createFakeMind(nameB);
    const { isolation } = containingIsolation();
    await addPagesWorktree(nameB, b, dataDir, isolation);
    // A can name the filter in a .gitattributes it publishes; B pulls it in.
    const wtB = resolve(b, "home", "pages", "_system");
    writeFileSync(resolve(wtB, ".gitattributes"), "*.md filter=probe\n");
    writeFileSync(resolve(wtB, "b.md"), "# B\n");
    const result = await pagesPullAndMerge(nameB, b, dataDir, "b", isolation);
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(existsSync(marker), false, "A's filter ran");
  });

  it("replaces a config swapped for a link, keeping history", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    await ensurePagesRepo(dataDir);
    const repo = pagesRepoDir(dataDir);
    // A mind's branch: what a re-init would drop (main alone could come back identical).
    git(repo, "branch", "some-mind");
    const head = git(repo, "rev-parse", "main");
    const config = resolve(repo, ".git", "config");
    const planted = resolve(voluteHome(), "test-pages-planted-config");
    writeFileSync(planted, `${readFileSync(config, "utf-8")}[filter "probe"]\n\tclean = x\n`);
    rmSync(config);
    symlinkSync(planted, config);

    await ensurePagesRepo(dataDir);

    assert.ok(lstatSync(config).isFile());
    assert.doesNotMatch(readFileSync(config, "utf-8"), /filter/);
    assert.equal(git(repo, "rev-parse", "main"), head);
    assert.equal(git(repo, "rev-parse", "some-mind"), head);
    assert.match(warn.mock.calls.map((c) => String(c.arguments[0])).join("\n"), /replacing/);
  });

  it("replaces a hard-linked config without touching the file it is linked to", async (t) => {
    t.mock.method(console, "warn", () => {});
    await ensurePagesRepo(dataDir);
    const repo = pagesRepoDir(dataDir);
    git(repo, "branch", "some-mind");
    const config = resolve(repo, ".git", "config");
    // A secret the daemon can read and a mind can't, with config made a second name for it.
    const secret = resolve(voluteHome(), "test-pages-secret");
    rmSync(secret, { force: true });
    writeFileSync(secret, "[core]\n\tbare = false\n", { mode: 0o600 });
    rmSync(config);
    linkSync(secret, config);

    await ensurePagesRepo(dataDir);

    assert.equal(statSync(secret).mode & 0o777, 0o600);
    assert.equal(statSync(secret).nlink, 1);
    assert.ok(lstatSync(config).isFile());
    assert.equal(git(repo, "rev-parse", "some-mind"), git(repo, "rev-parse", "main"));
  });

  it("refuses a repo directory that is a link, without wiping where it points", async () => {
    const repo = pagesRepoDir(dataDir);
    const elsewhere = resolve(voluteHome(), "test-pages-repo-elsewhere");
    rmSync(elsewhere, { recursive: true, force: true });
    mkdirSync(resolve(elsewhere, ".git"), { recursive: true });
    writeFileSync(resolve(elsewhere, ".git", "keep"), "x");
    mkdirSync(dataDir, { recursive: true });
    symlinkSync(elsewhere, repo);

    await assert.rejects(ensurePagesRepo(dataDir));
    assert.equal(readFileSync(resolve(elsewhere, ".git", "keep"), "utf-8"), "x");
    rmSync(repo);
  });

  it("relinks a worktree after a re-init, keeping the mind's files", async (t) => {
    t.mock.method(console, "warn", () => {});
    await ensurePagesRepo(dataDir);
    const name = "test-pages-relink";
    const mindDir = await createFakeMind(name);
    await addPagesWorktree(name, mindDir, dataDir);
    const wt = resolve(mindDir, "home", "pages", "_system");
    writeFileSync(resolve(wt, "kept.md"), "# Kept\n");

    rmSync(resolve(pagesRepoDir(dataDir), ".git"), { recursive: true, force: true });
    await ensurePagesRepo(dataDir); // a husk: re-initialized
    await addPagesWorktree(name, mindDir, dataDir);

    assert.ok(worktreeGitDir(pagesRepoDir(dataDir), wt), "the worktree is linked again");
    assert.equal(readFileSync(resolve(wt, "kept.md"), "utf-8"), "# Kept\n");
    assert.equal(git(wt, "status", "--porcelain"), "?? kept.md");
    const result = await pagesPullAndMerge(name, mindDir, dataDir, "kept");
    assert.ok(result.ok, JSON.stringify(result));
    assert.match(git(pagesRepoDir(dataDir), "ls-tree", "--name-only", "main"), /kept\.md/);
  });

  it("runs git in the mind's worktree as the mind, and no hook at all", async (t) => {
    t.mock.method(console, "warn", () => {});
    await ensurePagesRepo(dataDir);
    // The repo is group-writable by every mind, hooks directory included.
    const marker = resolve(voluteHome(), "test-pages-hook-ran");
    const hooks = resolve(pagesRepoDir(dataDir), ".git", "hooks");
    for (const hook of ["pre-commit", "post-checkout", "post-merge", "post-rewrite"]) {
      writeFileSync(resolve(hooks, hook), `#!/bin/sh\necho ${hook} >> "${marker}"\n`, {
        mode: 0o755,
      });
    }
    const name = "test-pages-as-mind";
    const mindDir = await createFakeMind(name);
    const { asMind, isolation } = containingIsolation();
    await addPagesWorktree(name, mindDir, dataDir, isolation);
    writeFileSync(resolve(mindDir, "home", "pages", "_system", "page.html"), "<p>hi</p>");
    const result = await pagesPullAndMerge(name, mindDir, dataDir, "publish", isolation);

    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(existsSync(marker), false, "a hook ran");
    const verbs = asMind.map(({ mind, args }) => {
      assert.equal(mind, name);
      return args.find((a) => !a.startsWith("-") && !a.includes("="));
    });
    for (const verb of ["add", "commit", "rebase", "reset"]) assert.ok(verbs.includes(verb), verb);
    // Root keeps the repo's own work: the squash merge is not the mind's to run.
    assert.equal(verbs.includes("merge"), false);
    await removePagesWorktree(name, mindDir, dataDir);
  });

  // #1330: a mind's git runs as a non-owner of the root-owned `.git`, so it can't take
  // `.git/packed-refs.lock`, which git needs to delete any ref. A test can't change
  // uid, so `.git` is made unwritable around each git the mind would run instead.
  describe("rebase leftovers in a gitdir the mind can't delete refs from", () => {
    const LEFTOVERS = ["CHERRY_PICK_HEAD", "REBASE_HEAD", "AUTO_MERGE"];

    function asNonOwner(fn: () => void) {
      const gitDir = resolve(pagesRepoDir(dataDir), ".git");
      const mode = statSync(gitDir).mode;
      chmodSync(gitDir, mode & ~0o222);
      try {
        fn();
      } finally {
        chmodSync(gitDir, mode);
      }
    }

    /** `containingIsolation`, with every git the mind runs denied `.git` itself. */
    function nonOwnerIsolation() {
      const { isolation } = containingIsolation();
      const gitDir = resolve(pagesRepoDir(dataDir), ".git");
      isolation.wrapForIsolation = async (cmd, args) => [
        "sh",
        ["-c", 'chmod a-w "$0"; "$@"; r=$?; chmod u+w "$0"; exit $r', gitDir, cmd, ...args],
      ];
      return isolation;
    }

    /** The mind's own git in its worktree, as a non-owner of `.git`. */
    const mindGit = (wt: string, ...args: string[]) => {
      let out = "";
      asNonOwner(() => {
        out = execFileSync("git", ["-c", "user.name=m", "-c", "user.email=m@m", ...args], {
          cwd: wt,
          env: cleanGitEnv(),
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      });
      return out;
    };

    const leftovers = (gitDir: string) => LEFTOVERS.filter((n) => existsSync(resolve(gitDir, n)));

    /** A and B, B's branch holding a commit to replay onto a main A moved. */
    async function diverged(tag: string, file: string, conflicting: boolean) {
      await ensurePagesRepo(dataDir);
      const [a, b] = [`test-pages-leftover-${tag}-a`, `test-pages-leftover-${tag}-b`];
      const dirA = await createFakeMind(a);
      const dirB = await createFakeMind(b);
      await addPagesWorktree(a, dirA, dataDir);
      await addPagesWorktree(b, dirB, dataDir);
      const wtB = resolve(dirB, "home", "pages", "_system");
      writeFileSync(resolve(dirA, "home", "pages", "_system", file), "version A\n");
      assert.ok((await pagesPullAndMerge(a, dirA, dataDir, "A")).ok);
      writeFileSync(resolve(wtB, conflicting ? file : `b-${file}`), "version B\n");
      mindGit(wtB, "add", "-A");
      // Dated apart from anything committed now, so a commit borrowing it stands out.
      mindGit(wtB, "commit", "-qm", "B", "--date=2001-01-01T00:00:00Z");
      const gitDir = worktreeGitDir(pagesRepoDir(dataDir), wtB)!;
      return { b, dirB, wtB, gitDir };
    }

    it("a successful pull leaves no cherry-pick behind", async (t) => {
      t.mock.method(console, "warn", () => {});
      const { b, dirB, wtB, gitDir } = await diverged("pull", "page.md", false);
      const result = await pagesPull(b, dirB, dataDir, nonOwnerIsolation());
      assert.ok(result.ok, JSON.stringify(result));
      assert.deepEqual(leftovers(gitDir), []);
      assert.doesNotMatch(git(wtB, "status"), /cherry-pick/);
    });

    it("a conflict stops the rebase, and publishing again finishes it once resolved", async (t) => {
      t.mock.method(console, "warn", () => {});
      const { b, dirB, wtB, gitDir } = await diverged("resolve", "page.md", true);
      const isolation = nonOwnerIsolation();

      const stopped = await pagesPullAndMerge(b, dirB, dataDir, "B", isolation);
      assert.equal(stopped.ok, false);
      assert.equal(stopped.conflicts, true);
      assert.match(stopped.message ?? "", /stopped on a conflict in pages\/_system: page\.md/);
      assert.match(stopped.message ?? "", /`git add` it, then publish/);
      // git status's own hint is named, and running it is not a dead end (#1330).
      assert.match(stopped.message ?? "", /`git status` will suggest `git rebase --continue`/);
      assert.match(stopped.message ?? "", /If you already ran it, publishing again still recovers/);
      // What the mind will see matches what it was told.
      const status = git(wtB, "status");
      assert.match(status, /You are currently rebasing/);
      assert.match(status, /both added:\s+page\.md|both modified:\s+page\.md/);
      assert.match(readFileSync(resolve(wtB, "page.md"), "utf-8"), /<<<<<<< /);

      // Publishing again before resolving refuses, and commits no conflict markers.
      const unresolved = await pagesPullAndMerge(b, dirB, dataDir, "B", isolation);
      assert.equal(unresolved.conflicts, true);
      assert.match(unresolved.message ?? "", /page\.md/);
      assert.equal(git(pagesRepoDir(dataDir), "show", "main:page.md"), "version A");
      assert.ok(existsSync(resolve(gitDir, "rebase-merge")), "still the mind's to resolve");

      // The documented recovery, as the mind: resolve, `git add`, publish again.
      writeFileSync(resolve(wtB, "page.md"), "version A and B\n");
      mindGit(wtB, "add", "page.md");
      const published = await pagesPullAndMerge(b, dirB, dataDir, "B", isolation);
      assert.ok(published.ok, JSON.stringify(published));
      assert.equal(git(pagesRepoDir(dataDir), "show", "main:page.md"), "version A and B");
      assert.deepEqual(leftovers(gitDir), []);
      assert.match(git(wtB, "status"), new RegExp(`On branch ${b}\\b`));
      assert.doesNotMatch(git(wtB, "status"), /cherry-pick|rebas/);
    });

    it("clears what a rebase the mind finished itself left behind", async (t) => {
      t.mock.method(console, "warn", () => {});
      const { b, dirB, wtB, gitDir } = await diverged("self", "page.md", true);
      const isolation = nonOwnerIsolation();
      assert.equal((await pagesPull(b, dirB, dataDir, isolation)).conflicts, true);

      writeFileSync(resolve(wtB, "page.md"), "version A and B\n");
      mindGit(wtB, "add", "page.md");
      // git prints the packed-refs.lock error here, finishes, and leaves its refs.
      mindGit(wtB, "-c", "core.editor=true", "rebase", "--continue");
      assert.ok(leftovers(gitDir).length > 0, "git could delete refs: the simulation is off");
      assert.match(git(wtB, "status"), /cherry-pick/);

      // A commit made over a stale CHERRY_PICK_HEAD takes that commit's author date.
      writeFileSync(resolve(wtB, "next.md"), "next\n");
      const result = await pagesPull(b, dirB, dataDir, isolation);
      assert.ok(result.ok, JSON.stringify(result));
      assert.deepEqual(leftovers(gitDir), []);
      assert.doesNotMatch(git(wtB, "status"), /cherry-pick/);
      const [subject, year] = git(wtB, "log", "-1", "--format=%s|%ad", "--date=format:%Y").split(
        "|",
      );
      assert.match(subject, /^wip: /);
      assert.ok(Number(year) > 2001, `the commit borrowed a stale author date (${year})`);
    });

    it("publishes what the mind staged after finishing a rebase itself (#1335)", async (t) => {
      t.mock.method(console, "warn", () => {});
      const { b, dirB, wtB, gitDir } = await diverged("self-staged", "page.md", true);
      const isolation = nonOwnerIsolation();
      assert.equal((await pagesPull(b, dirB, dataDir, isolation)).conflicts, true);
      writeFileSync(resolve(wtB, "page.md"), "version A and B\n");
      mindGit(wtB, "add", "page.md");
      mindGit(wtB, "-c", "core.editor=true", "rebase", "--continue");
      assert.ok(existsSync(resolve(gitDir, "CHERRY_PICK_HEAD")), "the simulation is off");

      // Staged over the leftover: git status calls it a cherry-pick, but it's the mind's.
      writeFileSync(resolve(wtB, "next.md"), "next\n");
      mindGit(wtB, "add", "next.md");
      assert.match(git(wtB, "status"), /cherry-pick/);
      const result = await pagesPullAndMerge(b, dirB, dataDir, "B", isolation);
      assert.ok(result.ok, JSON.stringify(result));
      assert.equal(git(pagesRepoDir(dataDir), "show", "main:next.md"), "next");
      assert.equal(git(pagesRepoDir(dataDir), "show", "main:page.md"), "version A and B");
      assert.deepEqual(leftovers(gitDir), []);
    });

    it("leaves a cherry-pick the mind started over a leftover alone (#1335)", async (t) => {
      t.mock.method(console, "warn", () => {});
      const { b, dirB, wtB, gitDir } = await diverged("pick-over", "page.md", true);
      const isolation = nonOwnerIsolation();
      assert.equal((await pagesPull(b, dirB, dataDir, isolation)).conflicts, true);
      writeFileSync(resolve(wtB, "page.md"), "version A and B\n");
      mindGit(wtB, "add", "page.md");
      mindGit(wtB, "-c", "core.editor=true", "rebase", "--continue");
      const stale = readFileSync(resolve(gitDir, "CHERRY_PICK_HEAD"), "utf-8");

      // B's original commit, replayed again: it conflicts with its own rebased copy.
      writeFileSync(resolve(wtB, "page.md"), "something else\n");
      mindGit(wtB, "commit", "-qam", "else");
      assert.throws(() => mindGit(wtB, "cherry-pick", stale.trim()));
      const pick = readFileSync(resolve(gitDir, "CHERRY_PICK_HEAD"), "utf-8");
      writeFileSync(resolve(wtB, "page.md"), "picked\n");
      mindGit(wtB, "add", "page.md");

      const refused = await pagesPull(b, dirB, dataDir, isolation);
      assert.equal(refused.ok, false);
      assert.match(refused.message ?? "", /a cherry-pick you started/);
      assert.equal(readFileSync(resolve(gitDir, "CHERRY_PICK_HEAD"), "utf-8"), pick);
      assert.match(git(wtB, "status", "--porcelain"), /^M {2}page\.md/m);
    });

    /** B's publish stopped on a conflict in page.md, as the mind will find it. */
    async function stoppedPublish(tag: string) {
      const d = await diverged(tag, "page.md", true);
      const isolation = nonOwnerIsolation();
      const stopped = await pagesPullAndMerge(d.b, d.dirB, dataDir, "B", isolation);
      assert.equal(stopped.conflicts, true, JSON.stringify(stopped));
      const publish = () => pagesPullAndMerge(d.b, d.dirB, dataDir, "B", isolation);
      return { ...d, isolation, publish };
    }
    const onMain = (file: string) => git(pagesRepoDir(dataDir), "show", `main:${file}`);

    it("finishes a rebase whose resolution an older auto-commit already committed", async (t) => {
      t.mock.method(console, "warn", () => {});
      const { wtB, gitDir, publish } = await stoppedPublish("autocommit");
      // What auto-commit did before it learned to wait: `git add` and `git commit`.
      writeFileSync(resolve(wtB, "page.md"), "version A and B\n");
      mindGit(wtB, "add", "page.md");
      mindGit(wtB, "commit", "-qm", "Update page.md");
      // Nothing staged, so `--continue` must delete CHERRY_PICK_HEAD, which it can't.
      assert.throws(() => mindGit(wtB, "-c", "core.editor=true", "rebase", "--continue"));

      const result = await publish();
      assert.ok(result.ok, JSON.stringify(result));
      assert.equal(onMain("page.md"), "version A and B");
      assert.deepEqual(leftovers(gitDir), []);
    });

    for (const committed of [false, true]) {
      it(`refuses conflict markers ${committed ? "committed" : "staged"} mid-rebase`, async (t) => {
        t.mock.method(console, "warn", () => {});
        const { wtB, gitDir, publish } = await stoppedPublish(`markers-${committed}`);
        mindGit(wtB, "add", "page.md"); // markers and all
        if (committed) mindGit(wtB, "commit", "-qm", "Update page.md");

        const result = await publish();
        assert.equal(result.ok, false);
        assert.match(result.message ?? "", /still have conflict markers .*: page\.md/);
        assert.equal(onMain("page.md"), "version A");
        assert.ok(existsSync(resolve(gitDir, "rebase-merge")), "still the mind's to resolve");
      });
    }

    it("publishes changes the mind made elsewhere while the rebase was stopped", async (t) => {
      t.mock.method(console, "warn", () => {});
      const { wtB, publish } = await stoppedPublish("elsewhere");
      writeFileSync(resolve(wtB, "page.md"), "version A and B\n");
      mindGit(wtB, "add", "page.md");
      // Left unstaged, as auto-commit now leaves them during a rebase: git's own
      // `--continue` would refuse with "You must edit all merge conflicts".
      writeFileSync(resolve(wtB, ".gitkeep"), "an edit to a tracked file\n");
      // A page about conflicts may show a marker: it isn't one this rebase left.
      writeFileSync(resolve(wtB, "new.md"), "a new page\n<<<<<<< like this\n");

      const result = await publish();
      assert.ok(result.ok, JSON.stringify(result));
      assert.equal(onMain("page.md"), "version A and B");
      assert.equal(onMain(".gitkeep"), "an edit to a tracked file");
      assert.equal(onMain("new.md"), "a new page\n<<<<<<< like this");
    });

    for (const op of ["cherry-pick", "merge"] as const) {
      it(`leaves a ${op} the mind started alone until it is finished`, async (t) => {
        t.mock.method(console, "warn", () => {});
        const { b, dirB, wtB, gitDir } = await diverged(`own-${op}`, "page.md", true);
        const isolation = nonOwnerIsolation();
        const head = op === "merge" ? "MERGE_HEAD" : "CHERRY_PICK_HEAD";
        assert.throws(() => mindGit(wtB, op, "main"));
        assert.ok(existsSync(resolve(gitDir, head)));

        const refused = await pagesPull(b, dirB, dataDir, isolation);
        assert.equal(refused.ok, false);
        assert.match(refused.message ?? "", new RegExp(`a ${op} you started`));
        assert.ok(existsSync(resolve(gitDir, head)), `${head} kept`);
        assert.match(git(wtB, "status", "--porcelain"), /^(UU|AA) page\.md/m);

        // Resolved and staged, but not committed: still the mind's, still untouched.
        writeFileSync(resolve(wtB, "page.md"), "version A and B\n");
        mindGit(wtB, "add", "page.md");
        const staged = await pagesPull(b, dirB, dataDir, isolation);
        assert.match(staged.message ?? "", new RegExp(`a ${op} you started`));
        assert.ok(existsSync(resolve(gitDir, head)), `${head} kept once staged`);

        // Finished the ordinary way. The pull then gets as far as its own rebase.
        mindGit(wtB, "-c", "core.editor=true", "commit", "--no-edit");
        const pulled = await pagesPull(b, dirB, dataDir, isolation);
        assert.doesNotMatch(pulled.message ?? "", /you started/);
      });
    }

    /** B's branch has `git cherry-pick main` stopped on a conflict in page.md. */
    async function ownPickStopped(tag: string) {
      const d = await diverged(tag, "page.md", true);
      assert.throws(() => mindGit(d.wtB, "cherry-pick", "main"));
      return { ...d, isolation: nonOwnerIsolation() };
    }

    it("publishes a cherry-pick the mind stopped with --quit, keeping its changes", async (t) => {
      t.mock.method(console, "warn", () => {});
      const { b, dirB, wtB, gitDir, isolation } = await ownPickStopped("quit");
      writeFileSync(resolve(wtB, "page.md"), "version A and B\n");
      mindGit(wtB, "add", "page.md");
      const refused = await pagesPull(b, dirB, dataDir, isolation);
      assert.match(refused.message ?? "", /`git cherry-pick --continue`/);
      assert.match(refused.message ?? "", /`git cherry-pick --quit`, which keeps/);

      // The way out it was given keeps the staged resolution, and publishing commits it.
      mindGit(wtB, "cherry-pick", "--quit");
      const replayed = await pagesPullAndMerge(b, dirB, dataDir, "B", isolation);
      assert.doesNotMatch(replayed.message ?? "", /you started/);
      assert.equal(git(pagesRepoDir(dataDir), "show", `${b}:page.md`), "version A and B");
      // B's own first commit still meets main's on the way, as any publish of it would.
      assert.equal(replayed.conflicts, true, JSON.stringify(replayed));
      writeFileSync(resolve(wtB, "page.md"), "version A and B\n");
      mindGit(wtB, "add", "page.md");
      const result = await pagesPullAndMerge(b, dirB, dataDir, "B", isolation);
      assert.ok(result.ok, JSON.stringify(result));
      assert.equal(onMain("page.md"), "version A and B");
      assert.deepEqual(leftovers(gitDir), []);
    });

    it("never commits a conflict a --quit left unresolved", async (t) => {
      t.mock.method(console, "warn", () => {});
      const { b, dirB, wtB, isolation } = await ownPickStopped("quit-unresolved");
      const head = git(wtB, "rev-parse", "HEAD");
      mindGit(wtB, "cherry-pick", "--quit");
      assert.match(git(wtB, "status", "--porcelain"), /^(UU|AA) page\.md/m);

      const unresolved = await pagesPullAndMerge(b, dirB, dataDir, "B", isolation);
      assert.equal(unresolved.ok, false);
      assert.match(unresolved.message ?? "", /still marked as conflicted: page\.md/);
      assert.equal(git(wtB, "rev-parse", "HEAD"), head, "nothing committed");
      assert.equal(onMain("page.md"), "version A");
    });

    it("publishes a merge the mind ended with --quit, with what it changed in it", async (t) => {
      t.mock.method(console, "warn", () => {});
      const { b, dirB, wtB, gitDir } = await diverged("merge-quit", "page.md", true);
      const isolation = nonOwnerIsolation();
      assert.throws(() => mindGit(wtB, "merge", "main"));
      writeFileSync(resolve(wtB, "page.md"), "version A and B\n");
      writeFileSync(resolve(wtB, "extra.md"), "made during the merge\n");
      mindGit(wtB, "add", "page.md", "extra.md");
      const refused = await pagesPull(b, dirB, dataDir, isolation);
      assert.match(refused.message ?? "", /then end it with `git merge --quit`/);

      mindGit(wtB, "merge", "--quit");
      // B's own commit meets main's on the way, as any publish of it would.
      const replayed = await pagesPullAndMerge(b, dirB, dataDir, "B", isolation);
      assert.equal(replayed.conflicts, true, JSON.stringify(replayed));
      writeFileSync(resolve(wtB, "page.md"), "version A and B\n");
      mindGit(wtB, "add", "page.md");
      const result = await pagesPullAndMerge(b, dirB, dataDir, "B", isolation);
      assert.ok(result.ok, JSON.stringify(result));
      assert.equal(onMain("page.md"), "version A and B");
      assert.equal(onMain("extra.md"), "made during the merge");
      assert.deepEqual(leftovers(gitDir), []);
    });

    /** Commit `files` straight onto main, as if published long ago. */
    function onMainAlready(files: Record<string, string>) {
      const repo = pagesRepoDir(dataDir);
      for (const [f, text] of Object.entries(files)) writeFileSync(resolve(repo, f), text);
      git(repo, "add", ...Object.keys(files));
      git(repo, "-c", "user.name=x", "-c", "user.email=x@x", "commit", "-qm", "earlier");
    }

    const BLOCK = "<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\n";
    // Long enough that git still sees plain.md renamed once a block is added to it.
    const PLAIN = "plain\n".repeat(30);

    for (const [label, shape] of [
      ["committed by the mind", (wt: string) => writeFileSync(resolve(wt, "git.md"), BLOCK)],
      [
        "with CRLF line ends",
        (wt: string) => writeFileSync(resolve(wt, "git.md"), BLOCK.replace(/\n/g, "\r\n")),
      ],
      [
        "in a page renamed as it was added to",
        (wt: string) => {
          mindGit(wt, "mv", "plain.md", "git.md");
          writeFileSync(resolve(wt, "git.md"), `${PLAIN}${BLOCK}`);
        },
      ],
      [
        "beside an example the page already showed",
        (wt: string) => writeFileSync(resolve(wt, "example.md"), `${BLOCK}text\n${BLOCK}`),
      ],
    ] as const) {
      it(`never publishes a conflict ${label}`, async (t) => {
        t.mock.method(console, "warn", () => {});
        await ensurePagesRepo(dataDir);
        onMainAlready({ "plain.md": PLAIN, "example.md": `${BLOCK}text\n` });
        const { b, dirB, wtB } = await diverged(`block-${label.split(" ")[1]}`, "page.md", false);
        const isolation = nonOwnerIsolation();
        assert.ok((await pagesPull(b, dirB, dataDir, isolation)).ok);
        shape(wtB);
        // Committed past every earlier check, as auto-commit or `--continue` would.
        mindGit(wtB, "add", "-A");
        mindGit(wtB, "commit", "-qm", "auto-commit");
        const main = git(pagesRepoDir(dataDir), "rev-parse", "main");
        if (label.includes("renamed")) {
          const status = git(pagesRepoDir(dataDir), "diff", "--name-status", `main...${b}`);
          assert.match(status, /^R\d+\s+plain\.md\s+git\.md$/m, "git sees the rename");
        }

        for (const publish of [pagesPullAndMerge, pagesMerge]) {
          const refused = await publish(b, dirB, dataDir, "B", isolation);
          assert.equal(refused.ok, false);
          assert.match(refused.message ?? "", /have a conflict in them .*: (git|example)\.md/);
          assert.equal(git(pagesRepoDir(dataDir), "rev-parse", "main"), main, "nothing merged");
        }
      });
    }

    it("publishes a page that showed a conflict, moved to a new name", async (t) => {
      t.mock.method(console, "warn", () => {});
      await ensurePagesRepo(dataDir);
      onMainAlready({ "example.md": `${BLOCK}${"some text\n".repeat(20)}` });
      const { b, dirB, wtB } = await diverged("block-moved", "page.md", false);
      const isolation = nonOwnerIsolation();
      assert.ok((await pagesPull(b, dirB, dataDir, isolation)).ok);
      mindGit(wtB, "mv", "example.md", "moved.md");
      mindGit(wtB, "commit", "-qm", "move");
      const result = await pagesPullAndMerge(b, dirB, dataDir, "B", isolation);
      assert.ok(result.ok, JSON.stringify(result));
      assert.match(onMain("moved.md"), /^=======$/m);
    });

    it("refuses what's too large to check for conflicts, with a reason", async (t) => {
      t.mock.method(console, "warn", () => {});
      const { b, dirB, wtB } = await diverged("block-huge", "page.md", false);
      writeFileSync(resolve(wtB, "huge.md"), "=======\n".repeat(2_200_000));
      const main = git(pagesRepoDir(dataDir), "rev-parse", "main");
      const refused = await pagesPullAndMerge(b, dirB, dataDir, "B", nonOwnerIsolation());
      assert.equal(refused.ok, false);
      assert.match(refused.message ?? "", /too large to check for conflict markers/);
      assert.equal(git(pagesRepoDir(dataDir), "rev-parse", "main"), main, "nothing merged");
    });

    it("reads a page as text for conflicts, whatever .gitattributes says", async (t) => {
      t.mock.method(console, "warn", () => {});
      await ensurePagesRepo(dataDir);
      onMainAlready({ ".gitattributes": "*.md -diff\n" });
      const { b, dirB, wtB } = await diverged("block-attrs", "page.md", false);
      const isolation = nonOwnerIsolation();
      assert.ok((await pagesPull(b, dirB, dataDir, isolation)).ok);
      writeFileSync(resolve(wtB, "git.md"), BLOCK);
      mindGit(wtB, "add", "git.md");
      mindGit(wtB, "commit", "-qm", "auto-commit");
      const refused = await pagesPullAndMerge(b, dirB, dataDir, "B", isolation);
      assert.match(refused.message ?? "", /have a conflict in them .*: git\.md/);
    });

    it("publishes edits to a page that already showed a conflict, and indented ones", async (t) => {
      t.mock.method(console, "warn", () => {});
      await ensurePagesRepo(dataDir);
      onMainAlready({ "example.md": `${BLOCK}text\n` });
      const { b, dirB, wtB } = await diverged("block-ok", "page.md", false);
      const isolation = nonOwnerIsolation();
      writeFileSync(resolve(wtB, "example.md"), `${BLOCK}more text\n`);
      writeFileSync(resolve(wtB, "git.md"), BLOCK.replace(/^/gm, "    "));
      const result = await pagesPullAndMerge(b, dirB, dataDir, "B", isolation);
      assert.ok(result.ok, JSON.stringify(result));
      assert.match(onMain("example.md"), /^more text$/m);
    });
    it("names the operation by git's record of it, not a leftover head beside it", async (t) => {
      t.mock.method(console, "warn", () => {});
      const pick = await ownPickStopped("label-pick");
      writeFileSync(resolve(pick.gitDir, "REVERT_HEAD"), git(pick.wtB, "rev-parse", "HEAD"));
      writeFileSync(resolve(pick.wtB, "page.md"), "version A and B\n");
      mindGit(pick.wtB, "add", "page.md");
      const picking = await pagesPull(pick.b, pick.dirB, dataDir, pick.isolation);
      assert.match(picking.message ?? "", /a cherry-pick you started/);

      // A revert of B's commit under a later edit of the same line, beside a stale pick head.
      const rev = await diverged("label-revert", "page.md", true);
      writeFileSync(resolve(rev.wtB, "page.md"), "version C\n");
      mindGit(rev.wtB, "commit", "-qam", "C");
      writeFileSync(resolve(rev.gitDir, "CHERRY_PICK_HEAD"), git(rev.wtB, "rev-parse", "HEAD"));
      assert.throws(() => mindGit(rev.wtB, "revert", "--no-edit", "HEAD~1"));
      writeFileSync(resolve(rev.wtB, "page.md"), "version C, B reverted\n");
      mindGit(rev.wtB, "add", "page.md");
      const reverting = await pagesPull(rev.b, rev.dirB, dataDir, nonOwnerIsolation());
      assert.match(reverting.message ?? "", /a revert you started/);
      assert.match(reverting.message ?? "", /`git revert --continue`/);
    });
    it("refuses a worktree taken off the mind's branch, as by `git rebase --quit`", async (t) => {
      t.mock.method(console, "warn", () => {});
      const { b, dirB, wtB, publish } = await stoppedPublish("rebase-quit");
      writeFileSync(resolve(wtB, "page.md"), "version A and B\n");
      mindGit(wtB, "add", "page.md");
      const tip = git(pagesRepoDir(dataDir), "rev-parse", b);
      mindGit(wtB, "rebase", "--quit");

      // What `--quit` leaves still reads as the rebase's last pick, which is named first.
      const picking = await publish();
      assert.match(picking.message ?? "", /a cherry-pick you started/);
      mindGit(wtB, "cherry-pick", "--quit");
      const refused = await publish();
      assert.equal(refused.ok, false);
      assert.match(refused.message ?? "", new RegExp(`isn't on your branch \\(${b}\\)`));
      assert.equal(git(pagesRepoDir(dataDir), "rev-parse", b), tip, "branch untouched");
      assert.equal(onMain("page.md"), "version A");
      assert.equal(git(wtB, "show", ":page.md"), "version A and B", "the mind's index kept");
      assert.equal((await pagesPull(b, dirB, dataDir, nonOwnerIsolation())).ok, false);
    });

    it("never finishes a rebase the mind stopped off its branch", async (t) => {
      t.mock.method(console, "warn", () => {});
      const { b, dirB, wtB, gitDir } = await diverged("detached-rebase", "page.md", true);
      const isolation = nonOwnerIsolation();
      const tip = git(pagesRepoDir(dataDir), "rev-parse", b);
      mindGit(wtB, "switch", "-q", "--detach");
      writeFileSync(resolve(wtB, "page.md"), "version D\n");
      mindGit(wtB, "commit", "-qam", "D");
      assert.throws(() => mindGit(wtB, "rebase", "main"));
      writeFileSync(resolve(wtB, "page.md"), "version A and D\n");
      mindGit(wtB, "add", "page.md");

      for (const publish of [pagesPullAndMerge, pagesMerge]) {
        const refused = await publish(b, dirB, dataDir, "B", isolation);
        assert.match(refused.message ?? "", new RegExp(`isn't on your branch \\(${b}\\)`));
      }
      assert.equal(git(pagesRepoDir(dataDir), "rev-parse", b), tip, "branch untouched");
      assert.equal(onMain("page.md"), "version A");
      assert.match(git(wtB, "status"), /rebas/, "still the mind's rebase");

      // As told: `git switch` refuses mid-rebase, so the rebase is finished first.
      const refused = await pagesPull(b, dirB, dataDir, isolation);
      assert.match(refused.message ?? "", /finish it first .*`git rebase --continue`/);
      assert.throws(() => mindGit(wtB, "switch", "-q", b));
      // Each stop resolved and published again, as the mind would, then `--continue`.
      for (let i = 0; existsSync(resolve(gitDir, "rebase-merge")) && i < 3; i++) {
        writeFileSync(resolve(wtB, "page.md"), "version A and D\n");
        mindGit(wtB, "add", "page.md");
        await pagesPull(b, dirB, dataDir, isolation);
        try {
          mindGit(wtB, "-c", "core.editor=true", "rebase", "--continue");
        } catch {}
      }
      assert.ok(!existsSync(resolve(gitDir, "rebase-merge")), "the mind's rebase finished");
      const after = await pagesPull(b, dirB, dataDir, isolation);
      assert.match(after.message ?? "", /isn't on your branch/);
      assert.doesNotMatch(after.message ?? "", /finish it first/);
      mindGit(wtB, "switch", "-q", b);
    });

    it("names a cherry-pick started off the branch before the way back", async (t) => {
      t.mock.method(console, "warn", () => {});
      const { b, dirB, wtB } = await diverged("detached-pick", "page.md", false);
      const isolation = nonOwnerIsolation();
      mindGit(wtB, "switch", "-q", "--detach");
      for (const v of ["one", "two"]) {
        writeFileSync(resolve(wtB, "x.md"), `${v}\n`);
        mindGit(wtB, "add", "x.md");
        mindGit(wtB, "commit", "-qm", v);
      }
      const commits = git(wtB, "rev-list", "--reverse", `${b}..HEAD`).split("\n");
      assert.throws(() => mindGit(wtB, "cherry-pick", commits[0]));
      writeFileSync(resolve(wtB, "x.md"), "three\n");
      mindGit(wtB, "add", "x.md");

      // Each refusal's advice, followed as given, leads to the next and then through.
      const picking = await pagesPullAndMerge(b, dirB, dataDir, "B", isolation);
      assert.match(picking.message ?? "", /a cherry-pick you started/);
      mindGit(wtB, "-c", "core.editor=true", "cherry-pick", "--continue");
      const off = await pagesPullAndMerge(b, dirB, dataDir, "B", isolation);
      assert.match(off.message ?? "", /isn't on your branch/);
      const noted = git(wtB, "rev-list", "--reverse", `${b}..HEAD`).split("\n");
      mindGit(wtB, "switch", "-q", b);
      mindGit(wtB, "cherry-pick", ...noted);
      const result = await pagesPullAndMerge(b, dirB, dataDir, "B", isolation);
      assert.ok(result.ok, JSON.stringify(result));
      assert.equal(onMain("x.md"), "three");
    });

    it("gets a commit made off the branch published the way the refusal says", async (t) => {
      t.mock.method(console, "warn", () => {});
      const { b, dirB, wtB } = await diverged("detached-commit", "page.md", false);
      const isolation = nonOwnerIsolation();
      mindGit(wtB, "switch", "-q", "--detach");
      writeFileSync(resolve(wtB, "kept.md"), "made off the branch\n");
      mindGit(wtB, "add", "kept.md");
      mindGit(wtB, "commit", "-qm", "kept");
      const refused = await pagesPullAndMerge(b, dirB, dataDir, "B", isolation);
      assert.match(refused.message ?? "", /note each commit first/);

      // As told: note it, switch back, cherry-pick it, publish again.
      const commit = git(wtB, "rev-parse", "HEAD");
      mindGit(wtB, "switch", "-q", b);
      mindGit(wtB, "cherry-pick", commit);
      const result = await pagesPullAndMerge(b, dirB, dataDir, "B", isolation);
      assert.ok(result.ok, JSON.stringify(result));
      assert.equal(onMain("kept.md"), "made off the branch");
    });
    it("clears the CHERRY_PICK_HEAD a finished cherry-pick of the mind's leaves", async (t) => {
      t.mock.method(console, "warn", () => {});
      const { b, dirB, wtB, gitDir } = await diverged("own-finished", "page.md", false);
      const isolation = nonOwnerIsolation();
      assert.ok((await pagesPull(b, dirB, dataDir, isolation)).ok);
      // Two edits to one line, then the first replayed on top: a conflict, all on B's
      // own branch, so the pull after it has nothing of main's to rebase onto.
      for (const v of ["one", "two"]) {
        writeFileSync(resolve(wtB, "page.md"), `${v}\n`);
        mindGit(wtB, "commit", "-qam", v);
      }
      assert.throws(() => mindGit(wtB, "cherry-pick", "HEAD~1"));
      writeFileSync(resolve(wtB, "page.md"), "three\n");
      mindGit(wtB, "add", "page.md");
      mindGit(wtB, "-c", "core.editor=true", "commit", "--no-edit");
      assert.match(git(wtB, "status"), /cherry-pick/, "git couldn't delete its ref");

      const result = await pagesPull(b, dirB, dataDir, isolation);
      assert.ok(result.ok, JSON.stringify(result));
      assert.deepEqual(leftovers(gitDir), []);
      assert.doesNotMatch(git(wtB, "status"), /cherry-pick/);
    });

    // A way out that discards the mind's staged or uncommitted work is never offered
    // (#1335): every refusal a mind can be given, checked as the words it would read.
    it("offers no way out that discards the mind's changes", () => {
      const R = REFUSALS;
      const files = ["page.md", "other.md"];
      const refusals = [
        R.stoppedOnConflict(files),
        R.markersMidRebase(files),
        R.rebaseUnfinished("error: something"),
        ...(["am", "merge", "cherry-pick", "revert"] as const).map(R.operationInProgress),
        R.unresolvedConflicts(files),
        R.conflictInBranch(files),
        R.TOO_LARGE_TO_CHECK,
        R.notOnBranch("some-mind"),
        R.notOnBranch("some-mind", true),
        R.hardLinked(files),
        R.UNVERIFIED_WORKTREE,
        R.refusedWorktree("some-mind", Object.assign(new Error("gone"), { code: "ENOENT" })),
        R.refusedWorktree("some-mind", new Error("a symlink")),
      ].map((r) => r.message);
      assert.equal(refusals.length, Object.keys(R).length + 5, "every refusal, every variant");
      // Every way back to publishing names the shared publish: a plain one never
      // sends pages/_system (#1353).
      const publishAgain = refusals.filter((x) => /publish(ing)? again/i.test(x));
      assert.ok(publishAgain.length >= 11, `${publishAgain.length} refusals say publish again`);
      for (const said of publishAgain) {
        assert.ok(said.includes('`volute pages publish --shared "<note>"`'), said);
      }
      const discards =
        /reset --hard|checkout -- \.|checkout -f|restore \.|clean -f|switch -f|--discard-changes/;
      for (const said of refusals) {
        assert.doesNotMatch(said, discards, said);
        // `--abort` only alongside what it discards.
        for (const sentence of said.split(/(?<=\.) /).filter((x) => x.includes("--abort"))) {
          assert.match(sentence, /discards every edit/, sentence);
        }
        // A switch leaves commits made off the branch behind: they're noted first.
        const switching = said.indexOf("git switch");
        const noted = said.indexOf("note each commit");
        if (switching >= 0) assert.ok(noted >= 0 && noted < said.lastIndexOf("git switch"), said);
      }
      // A pick is finished with `--continue`; a merge ends with `--quit`, never a commit.
      const [merge, revert] = [R.operationInProgress("merge"), R.operationInProgress("revert")];
      assert.match(revert.message, /`git revert --continue`/);
      assert.match(merge.message, /`git merge --quit`/);
      assert.match(merge.message, /Don't commit the merge/);
    });
    it("refuses a git am in progress instead of finishing it as a rebase", async (t) => {
      t.mock.method(console, "warn", () => {});
      const { b, dirB, gitDir } = await diverged("am", "page.md", false);
      // What `git am` leaves while it waits: rebase-apply/, marked as an am session.
      mkdirSync(resolve(gitDir, "rebase-apply"));
      writeFileSync(resolve(gitDir, "rebase-apply", "applying"), "");
      const result = await pagesPull(b, dirB, dataDir, nonOwnerIsolation());
      assert.equal(result.ok, false);
      assert.match(result.message ?? "", /`git am --continue`.*`git am --quit`/);
      assert.ok(existsSync(resolve(gitDir, "rebase-apply", "applying")));
      rmSync(resolve(gitDir, "rebase-apply"), { recursive: true });
    });

    it("refuses a worktree whose gitdir can't be vouched for, and commits nothing", async (t) => {
      t.mock.method(console, "warn", () => {});
      await ensurePagesRepo(dataDir);
      const name = "test-pages-leftover-unvouched";
      const mindDir = await createFakeMind(name);
      await addPagesWorktree(name, mindDir, dataDir);
      const wt = resolve(mindDir, "home", "pages", "_system");
      const real = readFileSync(resolve(wt, ".git"), "utf-8");
      const decoy = resolve(voluteHome(), "test-pages-unvouched-decoy");
      rmSync(decoy, { recursive: true, force: true });
      execFileSync("git", ["init", "-q", decoy], { env: cleanGitEnv() });
      writeFileSync(resolve(wt, ".git"), `gitdir: ${resolve(decoy, ".git")}\n`);
      writeFileSync(resolve(wt, "page.md"), "draft\n");

      const result = await pagesPull(name, mindDir, dataDir);
      assert.equal(result.ok, false);
      assert.match(result.message ?? "", /can't be checked/);
      assert.throws(() => git(decoy, "rev-parse", "HEAD"), "nothing committed through it");
      writeFileSync(resolve(wt, ".git"), real);
    });

    it("clears earlier leftovers at start, but never a stopped rebase's", async (t) => {
      t.mock.method(console, "warn", () => {});
      await ensurePagesRepo(dataDir);
      const name = "test-pages-leftover-start";
      const mindDir = await createFakeMind(name);
      await addPagesWorktree(name, mindDir, dataDir);
      const wt = resolve(mindDir, "home", "pages", "_system");
      const gitDir = worktreeGitDir(pagesRepoDir(dataDir), wt)!;
      const head = git(wt, "rev-parse", "HEAD");
      for (const n of LEFTOVERS) writeFileSync(resolve(gitDir, n), `${head}\n`);
      const { isolation } = containingIsolation();

      mkdirSync(resolve(gitDir, "rebase-merge"));
      await addPagesWorktree(name, mindDir, dataDir, isolation);
      assert.deepEqual(leftovers(gitDir), LEFTOVERS);

      rmSync(resolve(gitDir, "rebase-merge"), { recursive: true });
      await addPagesWorktree(name, mindDir, dataDir, isolation);
      assert.deepEqual(leftovers(gitDir), []);
    });
  });

  // #1326: worktrees provisioned while root still ran their git keep root-owned files
  // in their gitdir, and a 0644 COMMIT_EDITMSG fails every commit the mind now runs as
  // itself. A test can't be root, so the test's own uid stands in for the daemon's
  // and a second group of ours for the mind's ownership.
  describe("reclaimGitDir", () => {
    const otherGid = (t: TestContext, path: string) => {
      const ids = execFileSync("id", ["-G"], { encoding: "utf-8" }).trim().split(/\s+/);
      const gid = ids.map(Number).find((g) => g !== statSync(path).gid);
      if (gid === undefined && process.env.CI) assert.fail("CI needs a supplementary group");
      if (gid === undefined) t.skip("no second group to move files to");
      return gid;
    };

    async function legacyGitDir(name: string) {
      await ensurePagesRepo(dataDir);
      const mindDir = await createFakeMind(name);
      await addPagesWorktree(name, mindDir, dataDir);
      const wt = resolve(mindDir, "home", "pages", "_system");
      const gitDir = worktreeGitDir(pagesRepoDir(dataDir), wt)!;
      writeFileSync(resolve(gitDir, "COMMIT_EDITMSG"), "wip\n", { mode: 0o644 });
      writeFileSync(resolve(gitDir, "ORIG_HEAD"), git(wt, "rev-parse", "HEAD"));
      return { mindDir, wt, gitDir };
    }

    it("re-owns the daemon's files in the gitdir, and nothing else", async (t) => {
      const { mindDir, wt, gitDir } = await legacyGitDir("test-pages-reclaim");
      const gid = otherGid(t, gitDir);
      if (gid === undefined) return;
      // A second name for a file outside, and a link out: never re-owned.
      const outside = resolve(voluteHome(), "test-pages-reclaim-outside");
      writeFileSync(outside, "");
      linkSync(outside, resolve(gitDir, "planted"));
      const target = resolve(voluteHome(), "test-pages-reclaim-target");
      writeFileSync(target, "");
      symlinkSync(target, resolve(gitDir, "pointer"));
      const deep = resolve(gitDir, "logs", "HEAD");

      const reowned = reclaimGitDir(gitDir, userInfo().uid, { uid: userInfo().uid, gid });

      for (const name of ["", "COMMIT_EDITMSG", "ORIG_HEAD", "HEAD", "index"]) {
        assert.ok(reowned.includes(resolve(gitDir, name)), `${name || "gitdir"} re-owned`);
        assert.equal(lstatSync(resolve(gitDir, name)).gid, gid);
      }
      assert.notEqual(statSync(outside).gid, gid, "a hard link's file keeps its owner");
      assert.notEqual(statSync(target).gid, gid, "a symlink is never followed");
      assert.notEqual(lstatSync(deep).gid, gid, "only the gitdir's own files");
      // The mind's commit path, through the files it was handed.
      writeFileSync(resolve(wt, "page.html"), "<p>hi</p>");
      const result = await pagesPullAndMerge("test-pages-reclaim", mindDir, dataDir, "publish");
      assert.ok(result.ok, JSON.stringify(result));
    });

    it("leaves a gitdir with nothing of the daemon's in it alone", async (t) => {
      const { gitDir } = await legacyGitDir("test-pages-reclaim-clean");
      const gid = otherGid(t, gitDir);
      if (gid === undefined) return;
      // Nothing here is owned by this uid, so nothing is the "daemon's".
      const notOurs = userInfo().uid + 1;
      assert.deepEqual(reclaimGitDir(gitDir, notOurs, { uid: userInfo().uid, gid }), []);
      assert.notEqual(statSync(resolve(gitDir, "COMMIT_EDITMSG")).gid, gid);
    });
  });

  describe("worktreeGitDir", () => {
    async function twoWorktrees(tag: string) {
      await ensurePagesRepo(dataDir);
      const a = await createFakeMind(`test-pages-gitdir-${tag}-a`);
      const b = await createFakeMind(`test-pages-gitdir-${tag}-b`);
      await addPagesWorktree(`test-pages-gitdir-${tag}-a`, a, dataDir);
      await addPagesWorktree(`test-pages-gitdir-${tag}-b`, b, dataDir);
      const wtA = realpathSync(resolve(a, "home", "pages", "_system"));
      const wtB = realpathSync(resolve(b, "home", "pages", "_system"));
      const repo = pagesRepoDir(dataDir);
      const gitDirB = worktreeGitDir(repo, wtB);
      assert.ok(gitDirB, "an honest worktree's gitdir resolves");
      return { repo, wtA, gitDirA: worktreeGitDir(repo, wtA), wtB, gitDirB };
    }

    it("resolves an honest worktree's gitdir inside .git/worktrees", async () => {
      const { repo, gitDirA, gitDirB } = await twoWorktrees("honest");
      const worktrees = realpathSync(resolve(repo, ".git", "worktrees"));
      assert.equal(dirname(gitDirA!), worktrees);
      assert.equal(dirname(gitDirB), worktrees);
      assert.notEqual(gitDirA, gitDirB);
    });

    it("refuses a .git file pointed outside the repo's worktrees", async () => {
      const { wtA, repo } = await twoWorktrees("outside");
      const elsewhere = resolve(voluteHome(), "test-pages-gitdir-elsewhere");
      mkdirSync(elsewhere, { recursive: true });
      writeFileSync(resolve(elsewhere, "gitdir"), resolve(wtA, ".git"));
      writeFileSync(resolve(wtA, ".git"), `gitdir: ${elsewhere}\n`);
      assert.equal(worktreeGitDir(repo, wtA), null);
    });

    it("refuses a .git file pointed at another mind's gitdir", async () => {
      const { wtA, repo, gitDirB } = await twoWorktrees("other");
      writeFileSync(resolve(wtA, ".git"), `gitdir: ${gitDirB}\n`);
      assert.equal(worktreeGitDir(repo, wtA), null);
    });

    it("follows a relative back-pointer (worktree.useRelativePaths)", async () => {
      const { wtB, gitDirB, repo } = await twoWorktrees("relative");
      writeFileSync(resolve(gitDirB, "gitdir"), relative(gitDirB, resolve(wtB, ".git")));
      assert.equal(worktreeGitDir(repo, wtB), gitDirB);
    });

    it("refuses a .git swapped for a FIFO without blocking", async () => {
      const { wtA, repo } = await twoWorktrees("fifo");
      rmSync(resolve(wtA, ".git"));
      execFileSync("mkfifo", [resolve(wtA, ".git")]);
      assert.equal(worktreeGitDir(repo, wtA), null);
    });

    it("refuses a .git swapped for a symlink to another mind's .git", async () => {
      const { wtA, wtB, repo } = await twoWorktrees("symlink");
      rmSync(resolve(wtA, ".git"));
      symlinkSync(resolve(wtB, ".git"), resolve(wtA, ".git"));
      assert.equal(worktreeGitDir(repo, wtA), null);
    });
  });
});
