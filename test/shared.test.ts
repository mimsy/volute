import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { gitExec } from "../packages/daemon/src/lib/exec.js";
import { voluteHome } from "../packages/daemon/src/lib/registry.js";
import {
  addPagesWorktree,
  ensurePagesRepo,
  pagesLog,
  pagesMerge,
  pagesPull,
  pagesPullAndMerge,
  pagesRepoDir,
  pagesStatus,
  removePagesWorktree,
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
      const { rmSync } = await import("node:fs");
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

    const result = await pagesPull("test-pages-pull-noop", mindDir);
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
    const result = await pagesPull("test-pages-pull-dirty-b", mindDirB);
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
    const result = await pagesPull("test-pages-pull-b", mindDirB);
    assert.ok(result.ok);

    const content = readFileSync(resolve(worktreeB, "from-a.html"), "utf-8");
    assert.equal(content, "<p>from A</p>");

    await removePagesWorktree("test-pages-pull-a", mindDirA, dataDir);
    await removePagesWorktree("test-pages-pull-b", mindDirB, dataDir);
  });

  it("pagesPull detects conflicts and aborts cleanly", async () => {
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
    const result = await pagesPull("test-pages-pull-conflict-b", mindDirB);
    assert.equal(result.ok, false);
    assert.equal(result.conflicts, true);

    // Worktree should be usable (rebase was aborted)
    const branch = (await gitExec(["branch", "--show-current"], { cwd: worktreeB })).trim();
    assert.equal(branch, "test-pages-pull-conflict-b");

    await removePagesWorktree("test-pages-pull-conflict-a", mindDirA, dataDir);
    await removePagesWorktree("test-pages-pull-conflict-b", mindDirB, dataDir);
  });

  it("pagesStatus shows file status", async () => {
    await ensurePagesRepo(dataDir);
    const mindDir = await createFakeMind("test-pages-status");
    await addPagesWorktree("test-pages-status", mindDir, dataDir);

    const worktreePath = resolve(mindDir, "home", "pages", "_system");

    // No HTML files — should show no pages
    let status = await pagesStatus(mindDir);
    assert.equal(status, "No shared pages found.");

    // Make a change and commit — should show as draft
    writeFileSync(resolve(worktreePath, "new.html"), "<p>new</p>");
    await gitExec(["add", "-A"], { cwd: worktreePath });
    await gitExec(["commit", "--author", "test-pages-status <test@volute>", "-m", "add page"], {
      cwd: worktreePath,
    });

    status = await pagesStatus(mindDir);
    assert.ok(status.includes("new.html"));
    assert.ok(status.includes("draft"));

    // Merge to main — should show as published
    await pagesMerge("test-pages-status", mindDir, dataDir, "publish");
    status = await pagesStatus(mindDir);
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
    let log = await pagesLog(mindDir, 10);
    assert.ok(log.includes("init pages repo"));

    // Merge a change and check log
    writeFileSync(resolve(worktreePath, "index.html"), "<h1>Hi</h1>");
    await pagesMerge("test-pages-log", mindDir, dataDir, "Add index page");

    log = await pagesLog(mindDir, 10);
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

  it("pagesPullAndMerge returns nothing-to-publish when no changes", async () => {
    await ensurePagesRepo(dataDir);
    const mindDir = await createFakeMind("test-pam-noop");
    await addPagesWorktree("test-pam-noop", mindDir, dataDir);

    const result = await pagesPullAndMerge("test-pam-noop", mindDir, dataDir, "No changes");
    assert.ok(result.ok);
    assert.equal(result.message, "Nothing to publish");

    await removePagesWorktree("test-pam-noop", mindDir, dataDir);
  });

  it("pagesPullAndMerge detects conflicts during pull phase", async () => {
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

    // Worktree should be usable (rebase was aborted)
    const branch = (await gitExec(["branch", "--show-current"], { cwd: worktreeB })).trim();
    assert.equal(branch, "test-pam-conflict-b");

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
});
