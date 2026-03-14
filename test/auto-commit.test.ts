import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const tmpDir = join(tmpdir(), ".volute-autocommit-test");

function git(args: string[], cwd: string): string {
  const env: Record<string, string> = { LEFTHOOK: "0" };
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("GIT_") && v !== undefined) env[k] = v;
  }
  return execFileSync("git", args, { cwd, encoding: "utf-8", env });
}

describe("auto-commit batching", () => {
  const repoDir = join(tmpDir, "batch-repo");

  before(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
    mkdirSync(join(repoDir, "memory"), { recursive: true });
    git(["init", "-b", "main"], repoDir);
    git(["config", "user.email", "test@test.com"], repoDir);
    git(["config", "user.name", "Test"], repoDir);
    writeFileSync(join(repoDir, "SOUL.md"), "soul");
    git(["add", "-A"], repoDir);
    git(["commit", "-m", "initial"], repoDir);
  });

  after(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  it("batches multiple file changes into one commit", async () => {
    // Dynamic import to get fresh module state
    const { trackFileChange, flushFileChanges } = await import(
      "../templates/_base/src/lib/auto-commit.js"
    );

    // Create files
    writeFileSync(join(repoDir, "SOUL.md"), "updated soul");
    writeFileSync(join(repoDir, "memory", "2025-01-01.md"), "journal entry");

    // Track both changes
    trackFileChange("SOUL.md", repoDir);
    trackFileChange("memory/2025-01-01.md", repoDir);

    // Flush
    await flushFileChanges(repoDir);

    // Should have exactly one new commit (2 total including initial)
    const logOutput = git(["log", "--oneline"], repoDir).trim();
    const commits = logOutput.split("\n");
    assert.equal(commits.length, 2, `Expected 2 commits, got: ${logOutput}`);

    // The commit message should mention both files
    const lastMsg = git(["log", "-1", "--format=%s"], repoDir).trim();
    assert.ok(lastMsg.includes("SOUL.md"), `Expected commit to mention SOUL.md: ${lastMsg}`);
    assert.ok(
      lastMsg.includes("2025-01-01.md"),
      `Expected commit to mention 2025-01-01.md: ${lastMsg}`,
    );
  });

  it("flush with no pending files produces no commit", async () => {
    const { flushFileChanges } = await import("../templates/_base/src/lib/auto-commit.js");

    const beforeCount = git(["rev-list", "--count", "HEAD"], repoDir).trim();
    await flushFileChanges(repoDir);
    const afterCount = git(["rev-list", "--count", "HEAD"], repoDir).trim();

    assert.equal(beforeCount, afterCount, "No commit should be created when no files are pending");
  });
});
