import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { gitExec } from "@volute/shared/exec";
import { voluteHome } from "@volute/shared/registry";
import {
  addSharedWorktree,
  ensureSharedRepo,
  removeSharedWorktree,
  sharedDir,
  sharedLog,
  sharedMerge,
  sharedPull,
  sharedStatus,
} from "../src/lib/shared.js";

// Helper to create a fake mind directory with a git repo
async function createFakeMind(name: string): Promise<string> {
  const dir = resolve(voluteHome(), "minds", name);
  const homeDir = resolve(dir, "home");
  mkdirSync(homeDir, { recursive: true });
  await gitExec(["init"], { cwd: dir });
  await gitExec(["checkout", "-b", "main"], { cwd: dir });
  writeFileSync(resolve(homeDir, "SOUL.md"), "test");
  await gitExec(["add", "-A"], { cwd: dir });
  await gitExec(["commit", "-m", "init"], { cwd: dir });
  return dir;
}

describe("shared repo", () => {
  afterEach(async () => {
    // Clean up shared repo for fresh tests
    const dir = sharedDir();
    if (existsSync(dir)) {
      // Prune worktrees before removing
      try {
        await gitExec(["worktree", "prune"], { cwd: dir });
      } catch {
        // ignore
      }
      const { rmSync } = await import("node:fs");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sharedDir returns path under VOLUTE_HOME", () => {
    const dir = sharedDir();
    assert.ok(dir.endsWith("/shared"));
    assert.ok(dir.startsWith(voluteHome()));
  });

  it("ensureSharedRepo creates repo idempotently", async () => {
    await ensureSharedRepo();
    assert.ok(existsSync(resolve(sharedDir(), ".git")));
    assert.ok(existsSync(resolve(sharedDir(), "pages", ".gitkeep")));

    // Calling again should not fail
    await ensureSharedRepo();
    assert.ok(existsSync(resolve(sharedDir(), ".git")));
  });

  it("addSharedWorktree creates worktree on mind-named branch", async () => {
    await ensureSharedRepo();
    const mindDir = await createFakeMind("test-shared-add");
    await addSharedWorktree("test-shared-add", mindDir);

    const worktreePath = resolve(mindDir, "home", "shared");
    assert.ok(existsSync(worktreePath));
    assert.ok(existsSync(resolve(worktreePath, "pages", ".gitkeep")));

    // Verify branch name
    const branch = (await gitExec(["branch", "--show-current"], { cwd: worktreePath })).trim();
    assert.equal(branch, "test-shared-add");

    // Cleanup
    await removeSharedWorktree("test-shared-add", mindDir);
  });

  it("addSharedWorktree is idempotent", async () => {
    await ensureSharedRepo();
    const mindDir = await createFakeMind("test-shared-idempotent");
    await addSharedWorktree("test-shared-idempotent", mindDir);
    // Second call should not throw
    await addSharedWorktree("test-shared-idempotent", mindDir);

    await removeSharedWorktree("test-shared-idempotent", mindDir);
  });

  it("removeSharedWorktree cleans up", async () => {
    await ensureSharedRepo();
    const mindDir = await createFakeMind("test-shared-remove");
    await addSharedWorktree("test-shared-remove", mindDir);

    const worktreePath = resolve(mindDir, "home", "shared");
    assert.ok(existsSync(worktreePath));

    await removeSharedWorktree("test-shared-remove", mindDir);

    // Worktree dir should be gone
    assert.ok(!existsSync(worktreePath));

    // Branch should be gone
    try {
      await gitExec(["rev-parse", "--verify", "test-shared-remove"], { cwd: sharedDir() });
      assert.fail("Branch should have been deleted");
    } catch {
      // Expected — branch was deleted
    }
  });

  it("removeSharedWorktree is safe when no worktree exists", async () => {
    await ensureSharedRepo();
    const mindDir = await createFakeMind("test-shared-remove-noop");
    // Should not throw
    await removeSharedWorktree("test-shared-remove-noop", mindDir);
  });

  it("sharedMerge squash-merges to main", async () => {
    await ensureSharedRepo();
    const mindDir = await createFakeMind("test-merge");
    await addSharedWorktree("test-merge", mindDir);

    const worktreePath = resolve(mindDir, "home", "shared");

    // Create a file in the worktree
    writeFileSync(resolve(worktreePath, "pages", "index.html"), "<h1>Hello</h1>");

    const result = await sharedMerge("test-merge", mindDir, "Add index page");
    assert.ok(result.ok);

    // Verify the file is on main
    const mainContent = await gitExec(["show", "main:pages/index.html"], { cwd: sharedDir() });
    assert.equal(mainContent, "<h1>Hello</h1>");

    // Verify mind's branch was reset to main
    const diff = (
      await gitExec(["diff", "main...test-merge", "--stat"], { cwd: sharedDir() })
    ).trim();
    assert.equal(diff, "");

    await removeSharedWorktree("test-merge", mindDir);
  });

  it("sharedMerge returns nothing-to-merge when no changes", async () => {
    await ensureSharedRepo();
    const mindDir = await createFakeMind("test-merge-empty");
    await addSharedWorktree("test-merge-empty", mindDir);

    const result = await sharedMerge("test-merge-empty", mindDir, "No changes");
    assert.ok(result.ok);
    assert.equal(result.message, "Nothing to merge");

    await removeSharedWorktree("test-merge-empty", mindDir);
  });

  it("sharedMerge detects conflicts and aborts cleanly", async () => {
    await ensureSharedRepo();

    const mindDirA = await createFakeMind("test-conflict-a");
    const mindDirB = await createFakeMind("test-conflict-b");
    await addSharedWorktree("test-conflict-a", mindDirA);
    await addSharedWorktree("test-conflict-b", mindDirB);

    const worktreeA = resolve(mindDirA, "home", "shared");
    const worktreeB = resolve(mindDirB, "home", "shared");

    // Both minds edit the same file differently
    writeFileSync(resolve(worktreeA, "pages", "conflict.txt"), "version A");
    writeFileSync(resolve(worktreeB, "pages", "conflict.txt"), "version B");

    // Mind A merges first — should succeed
    const resultA = await sharedMerge("test-conflict-a", mindDirA, "A's version");
    assert.ok(resultA.ok);

    // Mind B merges — should detect conflict
    const resultB = await sharedMerge("test-conflict-b", mindDirB, "B's version");
    assert.equal(resultB.ok, false);
    assert.equal(resultB.conflicts, true);

    // Verify main is clean (A's version persists, not broken)
    const mainContent = await gitExec(["show", "main:pages/conflict.txt"], { cwd: sharedDir() });
    assert.equal(mainContent, "version A");

    await removeSharedWorktree("test-conflict-a", mindDirA);
    await removeSharedWorktree("test-conflict-b", mindDirB);
  });

  it("sharedPull rebases mind branch onto main", async () => {
    await ensureSharedRepo();

    // Set up two minds
    const mindDirA = await createFakeMind("test-pull-a");
    const mindDirB = await createFakeMind("test-pull-b");
    await addSharedWorktree("test-pull-a", mindDirA);
    await addSharedWorktree("test-pull-b", mindDirB);

    // Mind A creates a file and merges
    const worktreeA = resolve(mindDirA, "home", "shared");
    writeFileSync(resolve(worktreeA, "pages", "from-a.txt"), "from mind A");
    await sharedMerge("test-pull-a", mindDirA, "Add from-a.txt");

    // Mind B pulls to get A's changes
    const result = await sharedPull("test-pull-b", mindDirB);
    assert.ok(result.ok);

    // Verify B can see A's file
    const worktreeB = resolve(mindDirB, "home", "shared");
    assert.ok(existsSync(resolve(worktreeB, "pages", "from-a.txt")));
    assert.equal(readFileSync(resolve(worktreeB, "pages", "from-a.txt"), "utf-8"), "from mind A");

    await removeSharedWorktree("test-pull-a", mindDirA);
    await removeSharedWorktree("test-pull-b", mindDirB);
  });

  it("sharedLog shows history", async () => {
    await ensureSharedRepo();
    const log = await sharedLog(10);
    assert.ok(log.includes("init shared repo"));
  });

  it("sharedStatus shows diff between main and mind branch", async () => {
    await ensureSharedRepo();
    const mindDir = await createFakeMind("test-status");
    await addSharedWorktree("test-status", mindDir);

    // Add a file
    const worktreePath = resolve(mindDir, "home", "shared");
    writeFileSync(resolve(worktreePath, "test.txt"), "hello");
    await gitExec(["add", "-A"], { cwd: worktreePath });
    await gitExec(["commit", "-m", "add test"], { cwd: worktreePath });

    const status = await sharedStatus("test-status");
    assert.ok(status.includes("test.txt"));

    await removeSharedWorktree("test-status", mindDir);
  });

  it("sharedStatus returns empty for no changes", async () => {
    await ensureSharedRepo();
    const mindDir = await createFakeMind("test-status-empty");
    await addSharedWorktree("test-status-empty", mindDir);

    const status = await sharedStatus("test-status-empty");
    assert.equal(status.trim(), "");

    await removeSharedWorktree("test-status-empty", mindDir);
  });
});
