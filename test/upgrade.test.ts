import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import {
  applyInitFiles,
  composeTemplate,
  copyTemplateToDir,
  findTemplatesDir,
  findTemplatesRoot,
  listFiles,
} from "../src/lib/template.js";

const tmpDir = join(tmpdir(), ".volute-upgrade-test");

function git(args: string[], cwd: string): string {
  // Strip ALL GIT_* env vars set by hooks (e.g. pre-push) that override cwd-based repo discovery
  const env: Record<string, string> = { LEFTHOOK: "0" };
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("GIT_") && v !== undefined) env[k] = v;
  }
  return execFileSync("git", args, { cwd, encoding: "utf-8", env });
}

function setupGitRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  git(["init", "-b", "main"], dir);
  git(["config", "user.email", "test@test.com"], dir);
  git(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "README.md"), "# Test Mind\n");
  git(["add", "-A"], dir);
  git(["commit", "-m", "initial commit"], dir);
}

describe("template helpers", () => {
  it("findTemplatesDir finds claude template", () => {
    const dir = findTemplatesDir("claude");
    assert.ok(dir.includes("templates/claude"));
    assert.ok(existsSync(dir));
  });

  it("findTemplatesDir exits for unknown template", () => {
    // We can't easily test process.exit, so just verify the known template works
    const dir = findTemplatesDir("claude");
    assert.ok(existsSync(dir));
  });

  it("copyTemplateToDir copies and substitutes", () => {
    const dest = join(tmpDir, "copy-test");
    if (existsSync(dest)) rmSync(dest, { recursive: true });

    const templatesRoot = findTemplatesRoot();
    const { composedDir, manifest } = composeTemplate(templatesRoot, "claude");
    try {
      copyTemplateToDir(composedDir, dest, "test-mind", manifest);
    } finally {
      rmSync(composedDir, { recursive: true, force: true });
    }

    // package.json should exist (renamed from .tmpl)
    assert.ok(existsSync(join(dest, "package.json")));
    assert.ok(!existsSync(join(dest, "package.json.tmpl")));

    // Name substitution should have happened
    const pkg = readFileSync(join(dest, "package.json"), "utf-8");
    assert.ok(pkg.includes("test-mind"));
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
    writeFileSync(join(dest, "home", "VOLUTE.md"), "volute info");

    applyInitFiles(dest);

    // .init/ should be gone
    assert.ok(!existsSync(join(dest, ".init")));
    // Files should be in home/
    assert.equal(readFileSync(join(dest, "home", "SOUL.md"), "utf-8"), "my soul");
    assert.equal(readFileSync(join(dest, "home", "MEMORY.md"), "utf-8"), "my memory");
    assert.ok(existsSync(join(dest, "home", "memory", ".gitkeep")));
    // Existing home/ files should be preserved
    assert.equal(readFileSync(join(dest, "home", "VOLUTE.md"), "utf-8"), "volute info");

    rmSync(dest, { recursive: true });
  });

  it("copyTemplateToDir substitutes {{name}} in .init/SOUL.md", () => {
    const dest = join(tmpDir, "subst-test");
    if (existsSync(dest)) rmSync(dest, { recursive: true });

    const templatesRoot = findTemplatesRoot();
    const { composedDir, manifest } = composeTemplate(templatesRoot, "claude");
    try {
      copyTemplateToDir(composedDir, dest, "test-mind", manifest);
    } finally {
      rmSync(composedDir, { recursive: true, force: true });
    }

    // .init/SOUL.md should have the name substituted
    const soul = readFileSync(join(dest, ".init", "SOUL.md"), "utf-8");
    assert.ok(soul.includes("test-mind"));
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
  const baseRepoDir = join(tmpDir, "upgrade-repo-base");

  before(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
    setupGitRepo(baseRepoDir);
  });

  beforeEach(() => {
    // Clean up previous test state but preserve base repo
    if (existsSync(repoDir)) rmSync(repoDir, { recursive: true });
    for (const name of ["shared-history-repo", "real-conflict-repo"]) {
      const d = join(tmpDir, name);
      if (existsSync(d)) rmSync(d, { recursive: true });
    }
    cpSync(baseRepoDir, repoDir, { recursive: true });
  });

  afterEach(() => {
    try {
      git(["worktree", "prune"], repoDir);
    } catch {
      // ignore
    }
  });

  after(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  it("can create an orphan branch and commit template files", () => {
    // Create orphan branch
    git(["checkout", "--orphan", "volute/template"], repoDir);
    git(["rm", "-rf", "--cached", "."], repoDir);

    // Add a template file
    writeFileSync(join(repoDir, "template.txt"), "template content");
    git(["add", "-A"], repoDir);
    git(["commit", "-m", "template update"], repoDir);

    // Verify commit exists on the branch
    const log = git(["log", "--oneline", "volute/template"], repoDir);
    assert.ok(log.includes("template update"));

    // Switch back
    git(["checkout", "main"], repoDir);

    // Main branch should not have template.txt
    assert.ok(!existsSync(join(repoDir, "template.txt")));
  });

  it("can create worktree and merge unrelated histories", () => {
    // Create orphan template branch
    git(["checkout", "--orphan", "volute/template"], repoDir);
    git(["rm", "-rf", "--cached", "."], repoDir);
    writeFileSync(join(repoDir, "new-file.txt"), "from template");
    git(["add", "-A"], repoDir);
    git(["commit", "-m", "template update"], repoDir);
    git(["checkout", "main"], repoDir);

    // Create worktree
    const worktreeDir = join(repoDir, ".variants", "upgrade");
    git(["worktree", "add", "-b", "upgrade", worktreeDir], repoDir);

    // Merge template
    git(
      ["merge", "volute/template", "--allow-unrelated-histories", "-m", "merge template"],
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
    git(["checkout", "--orphan", "volute/template"], repoDir);
    git(["rm", "-rf", "--cached", "."], repoDir);
    writeFileSync(join(repoDir, "conflict.txt"), "template version");
    git(["add", "-A"], repoDir);
    git(["commit", "-m", "template update"], repoDir);
    git(["checkout", "main"], repoDir);

    // Create worktree and try to merge
    const worktreeDir = join(repoDir, ".variants", "upgrade");
    git(["worktree", "add", "-b", "upgrade", worktreeDir], repoDir);

    let hadConflict = false;
    try {
      git(
        ["merge", "volute/template", "--allow-unrelated-histories", "-m", "merge template"],
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
    git(["checkout", "--orphan", "volute/template"], repoDir);
    git(["rm", "-rf", "--cached", "."], repoDir);
    writeFileSync(join(repoDir, "server.ts"), "v1");
    writeFileSync(join(repoDir, "config.ts"), "config-v1");
    git(["add", "-A"], repoDir);
    git(["commit", "-m", "template v1"], repoDir);
    git(["checkout", "main"], repoDir);

    // Merge template into main (simulating first upgrade)
    git(
      ["merge", "volute/template", "--allow-unrelated-histories", "-m", "first upgrade"],
      repoDir,
    );

    // Now update template branch (simulating second upgrade)
    git(["checkout", "volute/template"], repoDir);
    writeFileSync(join(repoDir, "server.ts"), "v2");
    git(["add", "-A"], repoDir);
    git(["commit", "-m", "template v2"], repoDir);
    git(["checkout", "main"], repoDir);

    // Create worktree and merge — should be a clean 3-way merge
    const worktreeDir = join(repoDir, ".variants", "upgrade2");
    git(["worktree", "add", "-b", "upgrade2", worktreeDir], repoDir);
    git(["merge", "volute/template", "-m", "second upgrade"], worktreeDir);

    // Should have updated server.ts but kept config.ts
    const server = readFileSync(join(worktreeDir, "server.ts"), "utf-8");
    assert.equal(server, "v2");
    const config = readFileSync(join(worktreeDir, "config.ts"), "utf-8");
    assert.equal(config, "config-v1");

    git(["worktree", "remove", worktreeDir], repoDir);
  });

  it("first upgrade is conflict-free when template branch created at mind creation", () => {
    // Simulate new creation flow: template branch created first, main branched from it
    const dir = join(tmpDir, "shared-history-repo");
    mkdirSync(dir, { recursive: true });
    git(["init"], dir);
    git(["config", "user.email", "test@test.com"], dir);
    git(["config", "user.name", "Test"], dir);

    // Step 1: Create template branch with infrastructure files
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "home"), { recursive: true });
    writeFileSync(join(dir, "src", "server.ts"), "server v1");
    writeFileSync(join(dir, "package.json"), '{"name": "test"}');
    writeFileSync(join(dir, "home", "VOLUTE.md"), "volute v1");
    git(["checkout", "--orphan", "volute/template"], dir);
    git(["add", "src/server.ts", "package.json", "home/VOLUTE.md"], dir);
    git(["commit", "-m", "template update"], dir);

    // Step 2: Branch main from template, add identity files
    git(["checkout", "-b", "main"], dir);
    writeFileSync(join(dir, "home", "SOUL.md"), "I am unique");
    writeFileSync(join(dir, "home", "MEMORY.md"), "my memories");
    git(["add", "-A"], dir);
    git(["commit", "-m", "initial commit"], dir);

    // Mind modifies identity files (normal mind activity)
    writeFileSync(join(dir, "home", "MEMORY.md"), "updated memories");
    git(["add", "-A"], dir);
    git(["commit", "-m", "mind changes"], dir);

    // First upgrade: update template branch
    git(["checkout", "volute/template"], dir);
    writeFileSync(join(dir, "src", "server.ts"), "server v2");
    writeFileSync(join(dir, "home", "VOLUTE.md"), "volute v2");
    git(["add", "-A"], dir);
    git(["commit", "-m", "template v2"], dir);
    git(["checkout", "main"], dir);

    // Merge — should be CLEAN (no --allow-unrelated-histories needed)
    const worktreeDir = join(dir, ".variants", "upgrade");
    git(["worktree", "add", "-b", "upgrade", worktreeDir], dir);
    git(["merge", "volute/template", "-m", "first upgrade"], worktreeDir);

    // Template files updated, identity files preserved
    assert.equal(readFileSync(join(worktreeDir, "src", "server.ts"), "utf-8"), "server v2");
    assert.equal(readFileSync(join(worktreeDir, "home", "VOLUTE.md"), "utf-8"), "volute v2");
    assert.equal(readFileSync(join(worktreeDir, "home", "SOUL.md"), "utf-8"), "I am unique");
    assert.equal(readFileSync(join(worktreeDir, "home", "MEMORY.md"), "utf-8"), "updated memories");

    git(["worktree", "remove", worktreeDir], dir);
  });

  it("first upgrade detects real conflicts when mind modified template files", () => {
    // Same shared-history setup, but mind modifies a file that template also changes
    const dir = join(tmpDir, "real-conflict-repo");
    mkdirSync(dir, { recursive: true });
    git(["init"], dir);
    git(["config", "user.email", "test@test.com"], dir);
    git(["config", "user.name", "Test"], dir);

    // Template branch
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "server.ts"), "server v1");
    git(["checkout", "--orphan", "volute/template"], dir);
    git(["add", "src/server.ts"], dir);
    git(["commit", "-m", "template update"], dir);

    // Main from template
    git(["checkout", "-b", "main"], dir);
    git(["commit", "--allow-empty", "-m", "initial commit"], dir);

    // Mind customizes a template file
    writeFileSync(join(dir, "src", "server.ts"), "server v1 - mind customized");
    git(["add", "-A"], dir);
    git(["commit", "-m", "mind customization"], dir);

    // Template update changes the same file
    git(["checkout", "volute/template"], dir);
    writeFileSync(join(dir, "src", "server.ts"), "server v2");
    git(["add", "-A"], dir);
    git(["commit", "-m", "template v2"], dir);
    git(["checkout", "main"], dir);

    // Merge should detect real conflict
    const worktreeDir = join(dir, ".variants", "upgrade");
    git(["worktree", "add", "-b", "upgrade", worktreeDir], dir);

    let hadConflict = false;
    try {
      git(["merge", "volute/template", "-m", "first upgrade"], worktreeDir);
    } catch {
      hadConflict = true;
    }

    assert.ok(hadConflict, "Expected conflict when both sides modified the same file");

    git(["merge", "--abort"], worktreeDir);
    git(["worktree", "remove", "--force", worktreeDir], dir);
  });

  it("template merge preserves mind home/ files when .init/ approach is used", () => {
    // Simulate a mind created with the .init/ approach:
    // main branch has SOUL.md/MEMORY.md in home/ (from applyInitFiles at creation)
    // plus upgrade-safe files like VOLUTE.md
    mkdirSync(join(repoDir, "src"), { recursive: true });
    mkdirSync(join(repoDir, "home", "memory"), { recursive: true });
    writeFileSync(join(repoDir, "src", "server.ts"), "server v1");
    writeFileSync(join(repoDir, "home", "SOUL.md"), "I am a unique mind");
    writeFileSync(join(repoDir, "home", "MEMORY.md"), "my memories");
    writeFileSync(join(repoDir, "home", "VOLUTE.md"), "volute info v1");
    writeFileSync(join(repoDir, "home", "memory", "2025-01-01.md"), "day log");
    git(["add", "-A"], repoDir);
    git(["commit", "-m", "mind files"], repoDir);

    // Create orphan template branch with ONLY upgrade-safe files
    // (no .init/, no SOUL.md/MEMORY.md — just what the template home/ has)
    git(["checkout", "--orphan", "volute/template"], repoDir);
    git(["rm", "-rf", "--cached", "."], repoDir);
    git(["clean", "-fd"], repoDir);
    mkdirSync(join(repoDir, "src"), { recursive: true });
    mkdirSync(join(repoDir, "home"), { recursive: true });
    writeFileSync(join(repoDir, "src", "server.ts"), "server v2");
    writeFileSync(join(repoDir, "home", "VOLUTE.md"), "volute info v2");
    git(["add", "-A"], repoDir);
    git(["commit", "-m", "template update"], repoDir);
    git(["checkout", "main"], repoDir);

    // Create worktree and merge
    const worktreeDir = join(repoDir, ".variants", "upgrade");
    git(["worktree", "add", "-b", "upgrade", worktreeDir], repoDir);
    try {
      git(
        ["merge", "volute/template", "--allow-unrelated-histories", "-m", "merge template"],
        worktreeDir,
      );
    } catch {
      // Auto-resolve conflicts
      git(["checkout", "--theirs", "src/"], worktreeDir);
      git(["checkout", "--theirs", "home/VOLUTE.md"], worktreeDir);
      git(["add", "-A"], worktreeDir);
      git(["commit", "-m", "merge template"], worktreeDir);
    }

    // Mind identity files should be preserved (they were never in the template branch)
    assert.equal(readFileSync(join(worktreeDir, "home", "SOUL.md"), "utf-8"), "I am a unique mind");
    assert.equal(readFileSync(join(worktreeDir, "home", "MEMORY.md"), "utf-8"), "my memories");
    assert.equal(
      readFileSync(join(worktreeDir, "home", "memory", "2025-01-01.md"), "utf-8"),
      "day log",
    );
    // VOLUTE.md should be updated from template
    assert.equal(readFileSync(join(worktreeDir, "home", "VOLUTE.md"), "utf-8"), "volute info v2");

    git(["worktree", "remove", "--force", worktreeDir], repoDir);
  });
});
