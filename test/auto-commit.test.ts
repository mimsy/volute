import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const tmpDir = join(tmpdir(), `.volute-autocommit-test-${process.pid}`);

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

  it("does not claim a gitignored file in the commit message (#656)", async () => {
    const { trackFileChange, flushFileChanges } = await import(
      "../templates/_base/src/lib/auto-commit.js"
    );

    // A new top-level home/ file gitignore blocks, alongside a normal file —
    // mirrors the reported repro (NOTE.md silently dropped by home/*).
    writeFileSync(join(repoDir, ".gitignore"), "NOTE.md\n");
    writeFileSync(join(repoDir, "SOUL.md"), "soul v3");
    writeFileSync(join(repoDir, "NOTE.md"), "the variant's new note");

    trackFileChange("SOUL.md", repoDir);
    trackFileChange("NOTE.md", repoDir);

    await flushFileChanges(repoDir);

    const lastMsg = git(["log", "-1", "--format=%s"], repoDir).trim();
    assert.ok(lastMsg.includes("SOUL.md"), `Expected commit to mention SOUL.md: ${lastMsg}`);
    assert.ok(
      !lastMsg.includes("NOTE.md"),
      `Commit message must not claim NOTE.md was committed when git add failed: ${lastMsg}`,
    );

    // The commit really doesn't contain it — the message wasn't just wrong,
    // git add genuinely failed on the gitignored path.
    const committedFiles = git(["show", "--name-only", "--format=", "HEAD"], repoDir).trim();
    assert.ok(!committedFiles.includes("NOTE.md"), "NOTE.md must not be in the commit tree");
  });

  it("does not commit a blank message when every tracked file is blocked", async () => {
    const { trackFileChange, flushFileChanges } = await import(
      "../templates/_base/src/lib/auto-commit.js"
    );

    // Stray content already staged by something other than this flush (e.g. the
    // mind ran `git add` itself) — must not be claimed by an unrelated blank commit.
    writeFileSync(join(repoDir, "unrelated.txt"), "pre-staged by someone else");
    git(["add", "unrelated.txt"], repoDir);

    writeFileSync(join(repoDir, "NOTE.md"), "the variant's new note, still ignored");
    trackFileChange("NOTE.md", repoDir);

    const beforeCount = git(["rev-list", "--count", "HEAD"], repoDir).trim();
    await flushFileChanges(repoDir);
    const afterCount = git(["rev-list", "--count", "HEAD"], repoDir).trim();

    assert.equal(
      beforeCount,
      afterCount,
      "auto-commit must not create a commit when nothing it tracked actually staged",
    );
  });

  it("does not claim a gitignored pages/_system file in the shared commit message (#656)", async () => {
    const { trackFileChange, flushFileChanges } = await import(
      "../templates/_base/src/lib/auto-commit.js"
    );

    const sharedDir = join(repoDir, "pages", "_system");
    mkdirSync(sharedDir, { recursive: true });
    git(["init", "-b", "main"], sharedDir);
    git(["config", "user.email", "test@test.com"], sharedDir);
    git(["config", "user.name", "Test"], sharedDir);
    writeFileSync(join(sharedDir, ".gitignore"), "draft.md\n");
    writeFileSync(join(sharedDir, "index.md"), "page");
    git(["add", "-A"], sharedDir);
    git(["commit", "-m", "initial"], sharedDir);

    writeFileSync(join(sharedDir, "index.md"), "page v2");
    writeFileSync(join(sharedDir, "draft.md"), "a draft gitignore blocks");

    trackFileChange("pages/_system/index.md", repoDir);
    trackFileChange("pages/_system/draft.md", repoDir);

    await flushFileChanges(repoDir);

    const lastMsg = git(["log", "-1", "--format=%s"], sharedDir).trim();
    assert.ok(
      lastMsg.includes("index.md"),
      `Expected shared commit to mention index.md: ${lastMsg}`,
    );
    assert.ok(
      !lastMsg.includes("draft.md"),
      `Shared commit message must not claim draft.md was committed when git add failed: ${lastMsg}`,
    );

    const committedFiles = git(["show", "--name-only", "--format=", "HEAD"], sharedDir).trim();
    assert.ok(
      !committedFiles.includes("draft.md"),
      "draft.md must not be in the shared commit tree",
    );
  });

  // #1330: committing mid-rebase stages half-resolved files and leaves a rebase the
  // mind's git can't continue. The publish that finishes the rebase commits the rest.
  it("does not commit in pages/_system while a rebase there is stopped", async () => {
    const { trackFileChange, flushFileChanges } = await import(
      "../templates/_base/src/lib/auto-commit.js"
    );
    const sharedDir = join(repoDir, "pages", "_system");
    if (!existsSync(join(sharedDir, ".git"))) {
      mkdirSync(sharedDir, { recursive: true });
      git(["init", "-b", "main"], sharedDir);
      git(["config", "user.email", "test@test.com"], sharedDir);
      git(["config", "user.name", "Test"], sharedDir);
    }
    writeFileSync(join(sharedDir, "clash.md"), "base");
    git(["add", "clash.md"], sharedDir);
    git(["commit", "-m", "base"], sharedDir);
    git(["checkout", "-q", "-b", "mine"], sharedDir);
    writeFileSync(join(sharedDir, "clash.md"), "mine");
    git(["commit", "-qam", "mine"], sharedDir);
    git(["checkout", "-q", "main"], sharedDir);
    writeFileSync(join(sharedDir, "clash.md"), "theirs");
    git(["commit", "-qam", "theirs"], sharedDir);
    git(["checkout", "-q", "mine"], sharedDir);
    assert.throws(() => git(["rebase", "main"], sharedDir));
    const head = git(["rev-parse", "HEAD"], sharedDir);

    writeFileSync(join(sharedDir, "clash.md"), "half-resolved\n<<<<<<< still here\n");
    trackFileChange("pages/_system/clash.md", repoDir);
    await flushFileChanges(repoDir);

    assert.equal(git(["rev-parse", "HEAD"], sharedDir), head, "nothing committed");
    assert.match(git(["status", "--porcelain"], sharedDir), /^UU clash\.md/m);
    git(["rebase", "--abort"], sharedDir);
  });
});

describe("auto-commit retries a failed commit (#1206)", () => {
  let scratch: string;
  let repoDir: string;
  let binDir: string;
  let gitLog: string;
  let refuseOnce: string;

  after(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "volute-autocommit-retry-"));
    repoDir = join(scratch, "repo");
    binDir = join(scratch, "bin");
    gitLog = join(scratch, "git-calls.txt");
    refuseOnce = join(scratch, "refuse-once");
    mkdirSync(repoDir, { recursive: true });
    git(["init", "-b", "main"], repoDir);
    git(["config", "user.email", "test@test.com"], repoDir);
    git(["config", "user.name", "Test"], repoDir);
    writeFileSync(join(repoDir, "SOUL.md"), "soul");
    writeFileSync(join(repoDir, "MEMORY.md"), "memory");
    git(["add", "-A"], repoDir);
    git(["commit", "-m", "initial"], repoDir);
    // Refuses one commit — the stand-in for a commit killed mid-flight.
    const hook = join(repoDir, ".git", "hooks", "pre-commit");
    writeFileSync(
      hook,
      `#!/bin/sh\nif [ -f "${refuseOnce}" ]; then rm "${refuseOnce}"; exit 1; fi\nexit 0\n`,
    );
    chmodSync(hook, 0o755);

    // A `git` on PATH that records each call, so the test can count spawns.
    const realGit = execFileSync("which", ["git"], { encoding: "utf-8" }).trim();
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, "git"),
      `#!/bin/sh\necho "$*" >> "${gitLog}"\nexec "${realGit}" "$@"\n`,
    );
    chmodSync(join(binDir, "git"), 0o755);
  });

  it("re-queues a failed commit's files, so the next flush commits them", async () => {
    const { trackFileChange, flushFileChanges, waitForCommits } = await import(
      "../templates/_base/src/lib/auto-commit.js"
    );
    const before = git(["rev-list", "--count", "HEAD"], repoDir).trim();
    writeFileSync(refuseOnce, "");
    writeFileSync(join(repoDir, "SOUL.md"), "soul, revised");
    trackFileChange("SOUL.md", repoDir);
    await flushFileChanges(repoDir);
    assert.equal(git(["rev-list", "--count", "HEAD"], repoDir).trim(), before, "refused");

    // What the shutdown flush does.
    await waitForCommits();
    await flushFileChanges(repoDir);
    assert.equal(git(["log", "-1", "--format=%s"], repoDir).trim(), "Update SOUL.md");
    assert.equal(git(["status", "--porcelain"], repoDir), "");
  });

  it("re-queues a failed pages/_system commit too", async () => {
    const { trackFileChange, flushFileChanges, waitForCommits } = await import(
      "../templates/_base/src/lib/auto-commit.js"
    );
    const sharedDir = join(repoDir, "pages", "_system");
    mkdirSync(sharedDir, { recursive: true });
    git(["init", "-b", "main"], sharedDir);
    git(["config", "user.email", "test@test.com"], sharedDir);
    git(["config", "user.name", "Test"], sharedDir);
    writeFileSync(join(sharedDir, "index.md"), "page");
    git(["add", "-A"], sharedDir);
    git(["commit", "-m", "initial"], sharedDir);
    const hook = join(sharedDir, ".git", "hooks", "pre-commit");
    writeFileSync(
      hook,
      `#!/bin/sh\nif [ -f "${refuseOnce}" ]; then rm "${refuseOnce}"; exit 1; fi\nexit 0\n`,
    );
    chmodSync(hook, 0o755);

    writeFileSync(refuseOnce, "");
    writeFileSync(join(sharedDir, "index.md"), "page v2");
    trackFileChange("pages/_system/index.md", repoDir);
    await flushFileChanges(repoDir);
    assert.equal(git(["log", "-1", "--format=%s"], sharedDir).trim(), "initial", "refused");

    await waitForCommits();
    await flushFileChanges(repoDir);
    assert.equal(git(["log", "-1", "--format=%s"], sharedDir).trim(), "Update index.md");
    assert.equal(git(["status", "--porcelain"], sharedDir), "");
  });

  it("stages a batch with one git add", async () => {
    const { trackFileChange, flushFileChanges } = await import(
      "../templates/_base/src/lib/auto-commit.js"
    );
    const priorPath = process.env.PATH;
    process.env.PATH = `${binDir}:${priorPath}`;
    try {
      writeFileSync(gitLog, "");
      writeFileSync(join(repoDir, "SOUL.md"), "soul, again");
      writeFileSync(join(repoDir, "MEMORY.md"), "memory, again");
      trackFileChange("SOUL.md", repoDir);
      trackFileChange("MEMORY.md", repoDir);
      await flushFileChanges(repoDir);
    } finally {
      process.env.PATH = priorPath;
    }
    const adds = readFileSync(gitLog, "utf-8")
      .split("\n")
      .filter((l) => l.startsWith("add "));
    assert.deepEqual(adds, ["add -- SOUL.md MEMORY.md"]);
    assert.equal(git(["status", "--porcelain", "--", "SOUL.md", "MEMORY.md"], repoDir), "");
  });
});
