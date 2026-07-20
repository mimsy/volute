import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  mergeOrAbort,
  restoreMergeDeletedHomeFiles,
} from "../packages/daemon/src/lib/mind/variants.js";

const tmpDir = join(tmpdir(), `.volute-upgrade-restore-test-${process.pid}`);

function git(args: string[], cwd: string): string {
  // Strip ALL GIT_* env vars set by hooks (e.g. pre-push) that override cwd-based repo discovery
  const env: Record<string, string> = { LEFTHOOK: "0" };
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("GIT_") && v !== undefined) env[k] = v;
  }
  return execFileSync("git", args, { cwd, encoding: "utf-8", env });
}

/** Allowlist .gitignore matching the shape templates ship (templates/_base/gitignore). */
const ALLOWLIST_GITIGNORE = [
  "home/*",
  "!home/SOUL.md",
  "!home/memory/",
  "!home/memory/**",
  "",
].join("\n");

/**
 * Build a mind repo where everything under home/ is tracked (the pre-allowlist
 * state), then run the exact upgrade sequence from the daemon's upgrade route:
 * worktree + `git rm -r --cached home/`, template-merge simulation introducing
 * the allowlist .gitignore, re-add of allowlisted files, and finally the
 * merge-back into the live dir. Returns the pre-merge HEAD, exactly what
 * mergeUpgradeAndRestart captures before `git merge`.
 */
function runUpgradeSequence(
  dir: string,
  wt: string,
  opts: { autoCommitOnMain?: boolean; afterTemplateMerge?: () => void } = {},
): string {
  // Mirrors the daemon's `git diff --cached --quiet ||` commit guard
  const commitIfChanged = (message: string) => {
    try {
      git(["diff", "--cached", "--quiet"], wt);
    } catch {
      git(["commit", "-m", message], wt);
    }
  };

  git(["worktree", "add", "-b", "upgrade", wt], dir);

  // Prep step: untrack home/, keep SOUL.md (stands in for the VOLUTE.md re-add)
  git(["rm", "-r", "--cached", "--ignore-unmatch", "home/"], wt);
  git(["checkout", "HEAD", "--", "home/SOUL.md"], wt);
  git(["add", "home/SOUL.md"], wt);
  commitIfChanged("prepare for home/ allowlist migration");

  // Simulated template merge: brings the new allowlist .gitignore
  writeFileSync(join(wt, ".gitignore"), ALLOWLIST_GITIGNORE);
  git(["add", ".gitignore"], wt);
  commitIfChanged("template merge (allowlist gitignore)");

  opts.afterTemplateMerge?.();

  // Re-add pass: only allowlisted files come back
  git(["add", "home/"], wt);
  commitIfChanged("re-add allowlisted home files");

  if (opts.autoCommitOnMain) {
    // Simulate mergeUpgradeAndRestart's "Auto-commit before upgrade merge"
    writeFileSync(join(dir, "drift.txt"), "uncommitted drift on main\n");
    git(["add", "-A"], dir);
    git(["commit", "-m", "Auto-commit before upgrade merge"], dir);
  }

  const preMergeHead = git(["rev-parse", "HEAD"], dir).trim();
  git(["merge", "upgrade"], dir);
  return preMergeHead;
}

describe("restoreMergeDeletedHomeFiles", () => {
  let dir: string;
  let wt: string;

  beforeEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    dir = join(tmpDir, "mind");
    wt = join(tmpDir, "wt");
    mkdirSync(join(dir, "home", ".local", "bin"), { recursive: true });
    mkdirSync(join(dir, "home", "memory"), { recursive: true });
    git(["init", "-b", "main"], dir);
    git(["config", "user.email", "test@test.com"], dir);
    git(["config", "user.name", "Test"], dir);
    writeFileSync(join(dir, "home", "SOUL.md"), "soul\n");
    writeFileSync(join(dir, "home", "memory", "note.md"), "memory\n");
    writeFileSync(join(dir, "home", ".gitconfig"), "[user]\n\tname = mind\n");
    writeFileSync(join(dir, "home", ".local", "bin", "volute"), "#!/bin/sh\n");
    writeFileSync(join(dir, "home", "with space.md"), "a filename with a space\n");
    writeFileSync(join(dir, "home", "notes [draft]*.md"), "pathspec-magic characters\n");
    git(["add", "-A"], dir);
    git(["commit", "-m", "initial (everything tracked, pre-allowlist)"], dir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("restores non-allowlisted home files deleted by a fast-forward merge-back", async () => {
    const preMergeHead = runUpgradeSequence(dir, wt);

    // The bug: the merge-back physically deleted these from the live dir
    assert.ok(!existsSync(join(dir, "home", ".gitconfig")), "repro precondition: file deleted");
    assert.ok(!existsSync(join(dir, "home", ".local", "bin", "volute")));
    assert.ok(!existsSync(join(dir, "home", "with space.md")));
    assert.ok(!existsSync(join(dir, "home", "notes [draft]*.md")));

    const restored = await restoreMergeDeletedHomeFiles(dir, preMergeHead);

    assert.deepEqual(restored.sort(), [
      "home/.gitconfig",
      "home/.local/bin/volute",
      "home/notes [draft]*.md",
      "home/with space.md",
    ]);
    assert.equal(readFileSync(join(dir, "home", ".gitconfig"), "utf-8"), "[user]\n\tname = mind\n");
    assert.equal(
      readFileSync(join(dir, "home", ".local", "bin", "volute"), "utf-8"),
      "#!/bin/sh\n",
    );
    assert.equal(
      readFileSync(join(dir, "home", "with space.md"), "utf-8"),
      "a filename with a space\n",
    );
    assert.equal(
      readFileSync(join(dir, "home", "notes [draft]*.md"), "utf-8"),
      "pathspec-magic characters\n",
    );

    // Allowlisted files survived the merge and are still tracked
    assert.equal(readFileSync(join(dir, "home", "SOUL.md"), "utf-8"), "soul\n");
    assert.equal(readFileSync(join(dir, "home", "memory", "note.md"), "utf-8"), "memory\n");

    // Restored files are on disk but NOT re-tracked — the migration's stated end state
    const tracked = git(["ls-files", "--", "home/"], dir).trim().split("\n");
    assert.ok(!tracked.includes("home/.gitconfig"), "restored file must stay untracked");
    assert.ok(!tracked.includes("home/.local/bin/volute"));
    // ...and the working tree is clean (nothing staged, nothing modified)
    assert.equal(git(["status", "--porcelain", "--untracked-files=no"], dir).trim(), "");
  });

  it("restores files when the merge-back is a true merge (auto-commit moved main)", async () => {
    const preMergeHead = runUpgradeSequence(dir, wt, { autoCommitOnMain: true });

    assert.ok(!existsSync(join(dir, "home", ".gitconfig")), "repro precondition: file deleted");

    const restored = await restoreMergeDeletedHomeFiles(dir, preMergeHead);

    assert.deepEqual(restored.sort(), [
      "home/.gitconfig",
      "home/.local/bin/volute",
      "home/notes [draft]*.md",
      "home/with space.md",
    ]);
    assert.equal(readFileSync(join(dir, "home", ".gitconfig"), "utf-8"), "[user]\n\tname = mind\n");
    // Main's own auto-committed drift is untouched
    assert.equal(readFileSync(join(dir, "drift.txt"), "utf-8"), "uncommitted drift on main\n");
  });

  it("does not resurrect allowlisted files the template merge deliberately deleted", async () => {
    // An allowlisted (still-trackable) file removed on the upgrade branch is
    // template intent, not migration fallout — restoring it would hand it back
    // to auto-commit as a zombie, re-created on every future upgrade.
    writeFileSync(join(dir, "home", "memory", "obsolete.md"), "removed by template\n");
    git(["add", "home/memory/obsolete.md"], dir);
    git(["commit", "-m", "track an allowlisted file the template will delete"], dir);

    const preMergeHead = runUpgradeSequence(dir, wt, {
      afterTemplateMerge: () => {
        // The prep step already untracked it; the template drops it from disk
        // so the re-add pass never brings it back — its deletion (vs the base
        // commit) rides the upgrade branch into the merge.
        rmSync(join(wt, "home", "memory", "obsolete.md"));
      },
    });

    const restored = await restoreMergeDeletedHomeFiles(dir, preMergeHead);

    assert.ok(!restored.includes("home/memory/obsolete.md"), "template deletion must stand");
    assert.ok(!existsSync(join(dir, "home", "memory", "obsolete.md")));
    // The migration's own victims are still restored
    assert.ok(restored.includes("home/.gitconfig"));
    assert.equal(readFileSync(join(dir, "home", ".gitconfig"), "utf-8"), "[user]\n\tname = mind\n");
  });

  it("restores a deleted file even when rename detection would pair it with an added file", async () => {
    // A deleted home file ≥50% similar to a file added in the same range is
    // reported as R, not D, under default rename detection — --no-renames
    // keeps it in the deleted set.
    const content = `${"shared line\n".repeat(50)}`;
    writeFileSync(join(dir, "home", "old-doc.md"), content);
    git(["add", "home/old-doc.md"], dir);
    git(["commit", "-m", "track a doc the template will ship elsewhere"], dir);

    const preMergeHead = runUpgradeSequence(dir, wt, {
      afterTemplateMerge: () => {
        // Tracked outside home/ so it pairs as the rename target
        writeFileSync(join(wt, "docs-copy.md"), content);
        git(["add", "docs-copy.md"], wt);
        git(["commit", "-m", "template adds a near-identical file"], wt);
      },
    });

    assert.ok(!existsSync(join(dir, "home", "old-doc.md")), "repro precondition: file deleted");

    const restored = await restoreMergeDeletedHomeFiles(dir, preMergeHead);

    assert.ok(restored.includes("home/old-doc.md"), "rename detection must not hide the deletion");
    assert.equal(readFileSync(join(dir, "home", "old-doc.md"), "utf-8"), content);
  });

  it("is a no-op when the merge deleted nothing under home/", async () => {
    // Already-migrated mind: only allowlisted files are tracked
    git(["rm", "-r", "--cached", "--ignore-unmatch", "home/"], dir);
    writeFileSync(join(dir, ".gitignore"), ALLOWLIST_GITIGNORE);
    git(["add", ".gitignore", "home/"], dir);
    git(["commit", "-m", "already migrated"], dir);

    const preMergeHead = runUpgradeSequence(dir, wt);

    const restored = await restoreMergeDeletedHomeFiles(dir, preMergeHead);
    assert.deepEqual(restored, []);

    // Untracked home files were never touched by any of this
    assert.equal(readFileSync(join(dir, "home", ".gitconfig"), "utf-8"), "[user]\n\tname = mind\n");
  });
});

describe("mergeOrAbort", () => {
  let dir: string;

  beforeEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    dir = join(tmpDir, "mind");
    mkdirSync(join(dir, "home"), { recursive: true });
    git(["init", "-b", "main"], dir);
    git(["config", "user.email", "test@test.com"], dir);
    git(["config", "user.name", "Test"], dir);
    writeFileSync(join(dir, "src.ts"), "original\n");
    writeFileSync(join(dir, "home", ".gitconfig"), "mind data\n");
    git(["add", "-A"], dir);
    git(["commit", "-m", "initial"], dir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rolls back a conflicted merge's clean deletions and leaves no merge in progress", async () => {
    // Branch: delete home/.gitconfig (clean deletion) + edit src.ts (will conflict)
    git(["checkout", "-b", "upgrade"], dir);
    git(["rm", "home/.gitconfig"], dir);
    writeFileSync(join(dir, "src.ts"), "branch edit\n");
    git(["add", "-A"], dir);
    git(["commit", "-m", "delete home file, edit src"], dir);
    // Main: conflicting edit to src.ts
    git(["checkout", "main"], dir);
    writeFileSync(join(dir, "src.ts"), "main edit\n");
    git(["add", "-A"], dir);
    git(["commit", "-m", "conflicting main edit"], dir);

    await assert.rejects(() => mergeOrAbort(dir, "upgrade"));

    // The clean deletion was rolled back with the rest of the merge
    assert.equal(readFileSync(join(dir, "home", ".gitconfig"), "utf-8"), "mind data\n");
    assert.equal(readFileSync(join(dir, "src.ts"), "utf-8"), "main edit\n");
    // No MERGE_HEAD left for a later auto-commit to conclude
    assert.ok(!existsSync(join(dir, ".git", "MERGE_HEAD")), "merge must be aborted");
    assert.equal(git(["status", "--porcelain"], dir).trim(), "");
  });

  it("merges cleanly when there is no conflict", async () => {
    git(["checkout", "-b", "upgrade"], dir);
    writeFileSync(join(dir, "src.ts"), "branch edit\n");
    git(["add", "-A"], dir);
    git(["commit", "-m", "branch edit"], dir);
    git(["checkout", "main"], dir);

    await mergeOrAbort(dir, "upgrade");

    assert.equal(readFileSync(join(dir, "src.ts"), "utf-8"), "branch edit\n");
  });
});
