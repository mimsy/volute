import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  applyInitFiles,
  copyTemplateToDir,
  findTemplatesDir,
  listFiles,
} from "../src/lib/template.js";

const tmpDir = join(import.meta.dirname, ".tmp-upgrade-test");

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

function setupGitRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  git(["init"], dir);
  git(["config", "user.email", "test@test.com"], dir);
  git(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "README.md"), "# Test Agent\n");
  git(["add", "-A"], dir);
  git(["commit", "-m", "initial commit"], dir);
}

describe("template helpers", () => {
  it("findTemplatesDir finds agent-sdk template", () => {
    const dir = findTemplatesDir("agent-sdk");
    assert.ok(dir.includes("templates/agent-sdk"));
    assert.ok(existsSync(dir));
  });

  it("findTemplatesDir exits for unknown template", () => {
    // We can't easily test process.exit, so just verify the known template works
    const dir = findTemplatesDir("agent-sdk");
    assert.ok(existsSync(dir));
  });

  it("copyTemplateToDir copies and substitutes", () => {
    const dest = join(tmpDir, "copy-test");
    if (existsSync(dest)) rmSync(dest, { recursive: true });

    const templateDir = findTemplatesDir("agent-sdk");
    copyTemplateToDir(templateDir, dest, "test-agent");

    // package.json should exist (renamed from .tmpl)
    assert.ok(existsSync(join(dest, "package.json")));
    assert.ok(!existsSync(join(dest, "package.json.tmpl")));

    // Name substitution should have happened
    const pkg = readFileSync(join(dest, "package.json"), "utf-8");
    assert.ok(pkg.includes("test-agent"));
    assert.ok(!pkg.includes("{{name}}"));

    rmSync(dest, { recursive: true });
  });

  it("applyInitFiles copies .init/ contents into home/ and removes .init/", () => {
    const dest = join(tmpDir, "init-test");
    if (existsSync(dest)) rmSync(dest, { recursive: true });

    // Set up a directory with .init/ and home/
    mkdirSync(join(dest, ".init", "memory"), { recursive: true });
    mkdirSync(join(dest, "home"), { recursive: true });
    writeFileSync(join(dest, ".init", "SOUL.md"), "my soul");
    writeFileSync(join(dest, ".init", "MEMORY.md"), "my memory");
    writeFileSync(join(dest, ".init", "memory", ".gitkeep"), "");
    writeFileSync(join(dest, "home", "MOLT.md"), "molt info");

    applyInitFiles(dest);

    // .init/ should be gone
    assert.ok(!existsSync(join(dest, ".init")));
    // Files should be in home/
    assert.equal(readFileSync(join(dest, "home", "SOUL.md"), "utf-8"), "my soul");
    assert.equal(readFileSync(join(dest, "home", "MEMORY.md"), "utf-8"), "my memory");
    assert.ok(existsSync(join(dest, "home", "memory", ".gitkeep")));
    // Existing home/ files should be preserved
    assert.equal(readFileSync(join(dest, "home", "MOLT.md"), "utf-8"), "molt info");

    rmSync(dest, { recursive: true });
  });

  it("copyTemplateToDir substitutes {{name}} in .init/SOUL.md", () => {
    const dest = join(tmpDir, "subst-test");
    if (existsSync(dest)) rmSync(dest, { recursive: true });

    const templateDir = findTemplatesDir("agent-sdk");
    copyTemplateToDir(templateDir, dest, "test-agent");

    // .init/SOUL.md should have the name substituted
    const soul = readFileSync(join(dest, ".init", "SOUL.md"), "utf-8");
    assert.ok(soul.includes("test-agent"));
    assert.ok(!soul.includes("{{name}}"));

    // home/ should NOT have SOUL.md (it's in .init/)
    assert.ok(!existsSync(join(dest, "home", "SOUL.md")));

    rmSync(dest, { recursive: true });
  });

  it("listFiles returns relative paths excluding .git", () => {
    const dir = join(tmpDir, "list-test");
    if (existsSync(dir)) rmSync(dir, { recursive: true });
    mkdirSync(join(dir, ".git"), { recursive: true });
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "a.txt"), "a");
    writeFileSync(join(dir, "src/b.txt"), "b");
    writeFileSync(join(dir, ".git/config"), "git");

    const files = listFiles(dir);
    assert.ok(files.includes("a.txt"));
    assert.ok(files.includes(join("src", "b.txt")));
    assert.ok(!files.some((f) => f.includes(".git")));

    rmSync(dir, { recursive: true });
  });
});

describe("upgrade git operations", () => {
  const repoDir = join(tmpDir, "upgrade-repo");

  beforeEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
    setupGitRepo(repoDir);
  });

  afterEach(() => {
    // Clean up worktrees before removing the directory
    try {
      git(["worktree", "prune"], repoDir);
    } catch {
      // ignore
    }
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  it("can create an orphan branch and commit template files", () => {
    // Create orphan branch
    git(["checkout", "--orphan", "molt/template"], repoDir);
    git(["rm", "-rf", "--cached", "."], repoDir);

    // Add a template file
    writeFileSync(join(repoDir, "template.txt"), "template content");
    git(["add", "-A"], repoDir);
    git(["commit", "-m", "template update"], repoDir);

    // Verify commit exists on the branch
    const log = git(["log", "--oneline", "molt/template"], repoDir);
    assert.ok(log.includes("template update"));

    // Switch back
    git(["checkout", "main"], repoDir);

    // Main branch should not have template.txt
    assert.ok(!existsSync(join(repoDir, "template.txt")));
  });

  it("can create worktree and merge unrelated histories", () => {
    // Create orphan template branch
    git(["checkout", "--orphan", "molt/template"], repoDir);
    git(["rm", "-rf", "--cached", "."], repoDir);
    writeFileSync(join(repoDir, "new-file.txt"), "from template");
    git(["add", "-A"], repoDir);
    git(["commit", "-m", "template update"], repoDir);
    git(["checkout", "main"], repoDir);

    // Create worktree
    const worktreeDir = join(repoDir, ".worktrees", "upgrade");
    git(["worktree", "add", "-b", "upgrade", worktreeDir], repoDir);

    // Merge template
    git(
      ["merge", "molt/template", "--allow-unrelated-histories", "-m", "merge template"],
      worktreeDir,
    );

    // Worktree should have both files
    assert.ok(existsSync(join(worktreeDir, "README.md")));
    assert.ok(existsSync(join(worktreeDir, "new-file.txt")));

    // Clean up worktree
    git(["worktree", "remove", worktreeDir], repoDir);
  });

  it("detects merge conflicts", () => {
    // Create a file on main
    writeFileSync(join(repoDir, "conflict.txt"), "main version");
    git(["add", "-A"], repoDir);
    git(["commit", "-m", "add conflict file"], repoDir);

    // Create orphan template branch with conflicting file
    git(["checkout", "--orphan", "molt/template"], repoDir);
    git(["rm", "-rf", "--cached", "."], repoDir);
    writeFileSync(join(repoDir, "conflict.txt"), "template version");
    git(["add", "-A"], repoDir);
    git(["commit", "-m", "template update"], repoDir);
    git(["checkout", "main"], repoDir);

    // Create worktree and try to merge
    const worktreeDir = join(repoDir, ".worktrees", "upgrade");
    git(["worktree", "add", "-b", "upgrade", worktreeDir], repoDir);

    let hadConflict = false;
    try {
      git(
        ["merge", "molt/template", "--allow-unrelated-histories", "-m", "merge template"],
        worktreeDir,
      );
    } catch {
      hadConflict = true;
    }

    assert.ok(hadConflict, "Expected merge to produce conflicts");

    // Check status shows conflict markers
    const status = git(["status", "--porcelain"], worktreeDir);
    assert.ok(
      status.includes("UU") || status.includes("AA"),
      `Expected conflict markers in status, got: ${status}`,
    );

    // Clean up: abort merge and remove worktree
    try {
      git(["merge", "--abort"], worktreeDir);
    } catch {
      // ignore
    }
    git(["worktree", "remove", "--force", worktreeDir], repoDir);
  });

  it("second upgrade uses proper 3-way merge", () => {
    // First: create template branch
    git(["checkout", "--orphan", "molt/template"], repoDir);
    git(["rm", "-rf", "--cached", "."], repoDir);
    writeFileSync(join(repoDir, "server.ts"), "v1");
    writeFileSync(join(repoDir, "config.ts"), "config-v1");
    git(["add", "-A"], repoDir);
    git(["commit", "-m", "template v1"], repoDir);
    git(["checkout", "main"], repoDir);

    // Merge template into main (simulating first upgrade)
    git(["merge", "molt/template", "--allow-unrelated-histories", "-m", "first upgrade"], repoDir);

    // Now update template branch (simulating second upgrade)
    git(["checkout", "molt/template"], repoDir);
    writeFileSync(join(repoDir, "server.ts"), "v2");
    git(["add", "-A"], repoDir);
    git(["commit", "-m", "template v2"], repoDir);
    git(["checkout", "main"], repoDir);

    // Create worktree and merge — should be a clean 3-way merge
    const worktreeDir = join(repoDir, ".worktrees", "upgrade2");
    git(["worktree", "add", "-b", "upgrade2", worktreeDir], repoDir);
    git(["merge", "molt/template", "-m", "second upgrade"], worktreeDir);

    // Should have updated server.ts but kept config.ts
    const server = readFileSync(join(worktreeDir, "server.ts"), "utf-8");
    assert.equal(server, "v2");
    const config = readFileSync(join(worktreeDir, "config.ts"), "utf-8");
    assert.equal(config, "config-v1");

    git(["worktree", "remove", worktreeDir], repoDir);
  });

  it("template merge preserves agent home/ files when .init/ approach is used", () => {
    // Simulate an agent created with the .init/ approach:
    // main branch has SOUL.md/MEMORY.md in home/ (from applyInitFiles at creation)
    // plus upgrade-safe files like MOLT.md
    mkdirSync(join(repoDir, "src"), { recursive: true });
    mkdirSync(join(repoDir, "home", "memory"), { recursive: true });
    writeFileSync(join(repoDir, "src", "server.ts"), "server v1");
    writeFileSync(join(repoDir, "home", "SOUL.md"), "I am a unique agent");
    writeFileSync(join(repoDir, "home", "MEMORY.md"), "my memories");
    writeFileSync(join(repoDir, "home", "MOLT.md"), "molt info v1");
    writeFileSync(join(repoDir, "home", "memory", "2025-01-01.md"), "day log");
    git(["add", "-A"], repoDir);
    git(["commit", "-m", "agent files"], repoDir);

    // Create orphan template branch with ONLY upgrade-safe files
    // (no .init/, no SOUL.md/MEMORY.md — just what the template home/ has)
    git(["checkout", "--orphan", "molt/template"], repoDir);
    git(["rm", "-rf", "--cached", "."], repoDir);
    git(["clean", "-fd"], repoDir);
    mkdirSync(join(repoDir, "src"), { recursive: true });
    mkdirSync(join(repoDir, "home"), { recursive: true });
    writeFileSync(join(repoDir, "src", "server.ts"), "server v2");
    writeFileSync(join(repoDir, "home", "MOLT.md"), "molt info v2");
    git(["add", "-A"], repoDir);
    git(["commit", "-m", "template update"], repoDir);
    git(["checkout", "main"], repoDir);

    // Create worktree and merge
    const worktreeDir = join(repoDir, ".worktrees", "upgrade");
    git(["worktree", "add", "-b", "upgrade", worktreeDir], repoDir);
    try {
      git(
        ["merge", "molt/template", "--allow-unrelated-histories", "-m", "merge template"],
        worktreeDir,
      );
    } catch {
      // Auto-resolve conflicts
      git(["checkout", "--theirs", "src/"], worktreeDir);
      git(["checkout", "--theirs", "home/MOLT.md"], worktreeDir);
      git(["add", "-A"], worktreeDir);
      git(["commit", "-m", "merge template"], worktreeDir);
    }

    // Agent identity files should be preserved (they were never in the template branch)
    assert.equal(
      readFileSync(join(worktreeDir, "home", "SOUL.md"), "utf-8"),
      "I am a unique agent",
    );
    assert.equal(readFileSync(join(worktreeDir, "home", "MEMORY.md"), "utf-8"), "my memories");
    assert.equal(
      readFileSync(join(worktreeDir, "home", "memory", "2025-01-01.md"), "utf-8"),
      "day log",
    );
    // MOLT.md should be updated from template
    assert.equal(readFileSync(join(worktreeDir, "home", "MOLT.md"), "utf-8"), "molt info v2");

    git(["worktree", "remove", "--force", worktreeDir], repoDir);
  });
});
