import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  mergeWithUntrackResolution,
  resolvePackageJsonConflict,
} from "../packages/daemon/src/lib/mind/upgrade.js";
import { cleanupVariant } from "../packages/daemon/src/lib/mind/variant-cleanup.js";
import { gitExec } from "../packages/daemon/src/lib/util/exec.js";
import { logBuffer } from "../packages/daemon/src/lib/util/log-buffer.js";

let repo: string;

async function git(...args: string[]): Promise<string> {
  return gitExec(args, { cwd: repo });
}

function write(rel: string, content: string) {
  const path = resolve(repo, rel);
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

async function commitAll(message: string) {
  await git("add", "-A");
  await git("commit", "-m", message);
}

describe("mergeWithUntrackResolution", () => {
  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "upgrade-merge-test-"));
    await git("init", "-b", "main");
    await git("config", "user.name", "test");
    await git("config", "user.email", "test@example.com");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("auto-resolves an untrack conflict for a path the merged .gitignore ignores", async () => {
    // Base: tracked file that the upgrade branch will migrate to ignored/untracked.
    write("home/.claude/junk.txt", "base content\n");
    await commitAll("initial");

    // Upgrade branch: ignore home/.claude/ and untrack the junk file.
    await git("checkout", "-b", "upgrade");
    write(".gitignore", "home/.claude/\n");
    await git("add", ".gitignore");
    await git("rm", "--cached", "home/.claude/junk.txt");
    await commitAll("migrate home/.claude to ignored");

    // Main: unrelated activity modifies the same file (e.g. auto-commit).
    await git("checkout", "main");
    write("home/.claude/junk.txt", "main's modified content\n");
    await commitAll("main activity");

    const result = await mergeWithUntrackResolution(repo, "upgrade", "test-mind");

    assert.deepEqual(result, { merged: true });

    const onDisk = readFileSync(resolve(repo, "home/.claude/junk.txt"), "utf-8");
    assert.equal(onDisk, "main's modified content\n");

    const tracked = (await git("ls-files")).split("\n").filter(Boolean);
    assert.ok(!tracked.includes("home/.claude/junk.txt"));

    assert.ok(!existsSync(resolve(repo, ".git/MERGE_HEAD")));
  });

  it("aborts and reports files on a genuine content conflict", async () => {
    write("src/file.ts", "export const value = 1;\n");
    await commitAll("initial");

    await git("checkout", "-b", "upgrade");
    write("src/file.ts", "export const value = 2;\n");
    await commitAll("upgrade edits value");

    await git("checkout", "main");
    write("src/file.ts", "export const value = 3;\n");
    await commitAll("main edits value");
    const preMergeContent = readFileSync(resolve(repo, "src/file.ts"), "utf-8");

    const result = await mergeWithUntrackResolution(repo, "upgrade", "test-mind");

    assert.deepEqual(result, { merged: false, files: ["src/file.ts"] });
    assert.ok(!existsSync(resolve(repo, ".git/MERGE_HEAD")));

    const restored = readFileSync(resolve(repo, "src/file.ts"), "utf-8");
    assert.equal(restored, preMergeContent);
  });

  it("restores ours' clean content (no conflict markers) when both branches edit an ignored path", async () => {
    // Base: tracked file that both branches will go on to edit.
    write("home/.claude/junk.txt", "base line\n");
    await commitAll("initial");

    // Upgrade branch: ignore home/.claude/ AND edit the file's content (still
    // tracked here — the file only becomes untracked as part of resolution).
    await git("checkout", "-b", "upgrade");
    write(".gitignore", "home/.claude/\n");
    await git("add", ".gitignore");
    write("home/.claude/junk.txt", "upgrade line\n");
    await commitAll("edit ignored file on upgrade branch");

    // Main: edits the same line — this produces a genuine UU content conflict
    // (conflict markers) on a path the merged .gitignore ignores.
    await git("checkout", "main");
    write("home/.claude/junk.txt", "main line\n");
    await commitAll("edit ignored file on main");

    const result = await mergeWithUntrackResolution(repo, "upgrade", "test-mind");

    assert.deepEqual(result, { merged: true });

    const onDisk = readFileSync(resolve(repo, "home/.claude/junk.txt"), "utf-8");
    assert.equal(onDisk, "main line\n");
    assert.doesNotMatch(onDisk, /<{7}|={7}|>{7}/);

    const tracked = (await git("ls-files")).split("\n").filter(Boolean);
    assert.ok(!tracked.includes("home/.claude/junk.txt"));

    assert.ok(!existsSync(resolve(repo, ".git/MERGE_HEAD")));
  });

  it("aborts and reports all unmerged files when a genuine conflict accompanies an auto-resolvable one", async () => {
    write("home/.claude/junk.txt", "base\n");
    write("src/file.ts", "export const value = 1;\n");
    await commitAll("initial");

    await git("checkout", "-b", "upgrade");
    write(".gitignore", "home/.claude/\n");
    await git("add", ".gitignore");
    await git("rm", "--cached", "home/.claude/junk.txt");
    write("src/file.ts", "export const value = 2;\n");
    await commitAll("migrate ignored file + edit src on upgrade branch");

    await git("checkout", "main");
    write("home/.claude/junk.txt", "main modified\n");
    write("src/file.ts", "export const value = 3;\n");
    await commitAll("edit both files on main");
    const preMergeJunk = readFileSync(resolve(repo, "home/.claude/junk.txt"), "utf-8");
    const preMergeSrc = readFileSync(resolve(repo, "src/file.ts"), "utf-8");

    const result = await mergeWithUntrackResolution(repo, "upgrade", "test-mind");

    assert.equal(result.merged, false);
    if (!result.merged) {
      assert.deepEqual(result.files.slice().sort(), ["home/.claude/junk.txt", "src/file.ts"]);
    }
    assert.ok(!existsSync(resolve(repo, ".git/MERGE_HEAD")));

    assert.equal(readFileSync(resolve(repo, "home/.claude/junk.txt"), "utf-8"), preMergeJunk);
    assert.equal(readFileSync(resolve(repo, "src/file.ts"), "utf-8"), preMergeSrc);
  });

  it("treats nothing as auto-resolvable when .gitignore itself is conflicted", async () => {
    write("home/.claude/junk.txt", "base\n");
    await commitAll("initial");

    // Upgrade branch adds .gitignore (ignoring home/.claude/) and untracks the file.
    await git("checkout", "-b", "upgrade");
    write(".gitignore", "home/.claude/\n");
    await git("add", ".gitignore");
    await git("rm", "--cached", "home/.claude/junk.txt");
    await commitAll("add .gitignore + untrack on upgrade branch");

    // Main independently adds a different .gitignore (add/add conflict) and
    // modifies the otherwise-ignorable file.
    await git("checkout", "main");
    write(".gitignore", "node_modules/\n");
    write("home/.claude/junk.txt", "main modified\n");
    await commitAll("add different .gitignore + edit file on main");

    const result = await mergeWithUntrackResolution(repo, "upgrade", "test-mind");

    assert.equal(result.merged, false);
    if (!result.merged) {
      assert.ok(result.files.includes(".gitignore"));
    }
    assert.ok(!existsSync(resolve(repo, ".git/MERGE_HEAD")));
  });
});

describe("cleanupVariant branch resolution", () => {
  let worktree: string;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "cleanup-variant-test-"));
    worktree = resolve(repo, ".variants", "upgrade");
    await git("init", "-b", "main");
    await git("config", "user.name", "test");
    await git("config", "user.email", "test@example.com");
    write("file.txt", "base\n");
    await commitAll("initial");
    await git("worktree", "add", "-b", "upgrade", worktree);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  // The upgrade "variant" has no DB row (it's a worktree/branch, not a
  // registered variant mind), so cleanupVariant's DB/name fallback lands on a
  // branch name ("<mind>-upgrade") that was never real — opts.branch overrides
  // that with the actual branch.
  it("opts.branch deletes the real branch instead of the DB-less name fallback", async () => {
    await cleanupVariant("somemind-upgrade", "somemind", repo, worktree, { branch: "upgrade" });

    const branches = (await git("branch", "--list", "upgrade")).trim();
    assert.equal(branches, "", "the real branch should have been deleted");
    assert.ok(!existsSync(worktree), "worktree should be removed");
  });

  it("downgrades a not-found branch delete to log.info instead of log.warn", async () => {
    const entries: { level: string; msg: string }[] = [];
    const unsub = logBuffer.subscribe((e) => entries.push(e));
    try {
      // No opts.branch — falls back to the variant name, which was never a real branch.
      await cleanupVariant("somemind-upgrade", "somemind", repo, worktree);
    } finally {
      unsub();
    }

    const warnings = entries.filter(
      (e) => e.level === "warn" && e.msg.includes("failed to delete branch"),
    );
    assert.equal(
      warnings.length,
      0,
      `should not warn on an expected not-found delete: ${JSON.stringify(warnings)}`,
    );
    const infos = entries.filter((e) => e.level === "info" && e.msg.includes("already deleted"));
    assert.ok(infos.length > 0, "should log at info that the branch was already deleted");
  });
});

describe("resolvePackageJsonConflict", () => {
  const pkg = (deps: Record<string, string>) =>
    `${JSON.stringify({ name: "m", version: "0.1.0", dependencies: deps }, null, 2)}\n`;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "upgrade-pkg-test-"));
    await git("init", "-b", "main");
    await git("config", "user.name", "test");
    await git("config", "user.email", "test@example.com");
    write("package.json", pkg({ "@anthropic-ai/tokenizer": "^0.0.4", tsx: "^4.23.1" }));
    await commitAll("initial");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  async function conflictWith(ours: Record<string, string>, theirs: Record<string, string>) {
    await git("checkout", "-b", "template");
    write("package.json", pkg(theirs));
    await commitAll("template update");
    await git("checkout", "main");
    write("package.json", pkg(ours));
    await commitAll("mind change");
    await assert.rejects(git("merge", "template", "-m", "merge template update"));
  }

  it("keeps a skill-added dependency beside the template's version bump (#1185)", async () => {
    await conflictWith(
      { "@anthropic-ai/tokenizer": "^0.0.4", libsql: "^0.5.22", tsx: "^4.23.1" },
      { "@anthropic-ai/tokenizer": "^0.0.4", tsx: "^4.23.15", zod: "^4.0.0" },
    );

    assert.equal(await resolvePackageJsonConflict(repo, "test-mind"), true);

    assert.equal(
      readFileSync(resolve(repo, "package.json"), "utf-8"),
      pkg({
        "@anthropic-ai/tokenizer": "^0.0.4",
        libsql: "^0.5.22",
        tsx: "^4.23.15",
        zod: "^4.0.0",
      }),
    );
    assert.equal((await git("diff", "--name-only", "--diff-filter=U")).trim(), "");
  });

  it("leaves the conflict when both sides changed the same dependency differently", async () => {
    await conflictWith(
      { "@anthropic-ai/tokenizer": "^0.0.4", tsx: "^4.30.0" },
      { "@anthropic-ai/tokenizer": "^0.0.4", tsx: "^4.23.15" },
    );

    assert.equal(await resolvePackageJsonConflict(repo, "test-mind"), false);

    assert.equal((await git("diff", "--name-only", "--diff-filter=U")).trim(), "package.json");
  });
});
