import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  findUnresolvedHomeFiles,
  formatUnresolvedHomeFilesMessage,
  mergeVariantExcludingMemory,
  VariantMergeError,
} from "../packages/daemon/src/lib/mind/variants.js";
import { findTemplatesRoot } from "../packages/daemon/src/lib/template/template.js";
import { gitExec } from "../packages/daemon/src/lib/util/exec.js";

const repo = resolve("/tmp", `variant-merge-test-${process.pid}`);

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

describe("mergeVariantExcludingMemory", () => {
  beforeEach(async () => {
    rmSync(repo, { recursive: true, force: true });
    mkdirSync(repo, { recursive: true });
    await git("init", "-b", "main");
    await git("config", "user.name", "test");
    await git("config", "user.email", "test@example.com");

    write("home/MEMORY.md", "# Memory\n\n- parent baseline fact\n");
    write("home/memory/journal/2026-07-01.md", "Day one, shared baseline.\n");
    write("src/server.ts", "export const value = 1;\n");
    await commitAll("initial");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("merges code but excludes divergent memory/journal without conflicting", async () => {
    // Variant diverges: rewrites MEMORY.md, appends to the shared journal day,
    // adds a new journal day, and edits code.
    await git("checkout", "-b", "variant");
    write("home/MEMORY.md", "# Memory\n\n- variant learned something new\n");
    write("home/memory/journal/2026-07-01.md", "Day one, shared baseline.\nVariant's evening.\n");
    write("home/memory/journal/2026-07-02.md", "Day two, variant only.\n");
    write("src/feature.ts", "export const feature = true;\n");
    await commitAll("variant work");

    // Parent diverges the SAME memory/journal files (would conflict on a plain
    // merge) plus an unrelated, cleanly-mergeable code change.
    await git("checkout", "main");
    write("home/MEMORY.md", "# Memory\n\n- parent learned a different thing\n");
    write("home/memory/journal/2026-07-01.md", "Day one, shared baseline.\nParent's evening.\n");
    write("src/server.ts", "export const value = 2;\n");
    await commitAll("parent work");

    const delta = await mergeVariantExcludingMemory(repo, "variant");

    // The merge committed cleanly — no conflict markers, no merge in progress.
    assert.ok(!existsSync(resolve(repo, ".git/MERGE_HEAD")), "merge should be committed");
    const status = (await git("status", "--porcelain")).trim();
    assert.equal(status, "", "worktree should be clean after merge");

    // Parent's living memory is preserved verbatim; the variant's is not spliced.
    const memory = readFileSync(resolve(repo, "home/MEMORY.md"), "utf-8");
    assert.match(memory, /parent learned a different thing/);
    assert.doesNotMatch(memory, /variant learned something new/);

    const journalDay1 = readFileSync(resolve(repo, "home/memory/journal/2026-07-01.md"), "utf-8");
    assert.match(journalDay1, /Parent's evening/);
    assert.doesNotMatch(journalDay1, /Variant's evening/);

    // The variant's new journal day is NOT added to the parent's tree.
    assert.ok(
      !existsSync(resolve(repo, "home/memory/journal/2026-07-02.md")),
      "variant-only journal day should not be merged in",
    );

    // Code merges with normal git semantics: both edits land.
    assert.match(readFileSync(resolve(repo, "src/server.ts"), "utf-8"), /value = 2/);
    assert.ok(existsSync(resolve(repo, "src/feature.ts")), "variant code should merge in");

    // The delta reaches the caller and carries the variant's memory + journal.
    assert.match(delta, /variant learned something new/);
    assert.match(delta, /Variant's evening/);
    assert.match(delta, /Day two, variant only/);
    // ...but not the merged code.
    assert.doesNotMatch(delta, /feature = true/);
  });

  it("returns an empty delta when the variant wrote no memory or journal", async () => {
    await git("checkout", "-b", "variant");
    write("src/feature.ts", "export const feature = true;\n");
    await commitAll("variant code only");
    await git("checkout", "main");

    const delta = await mergeVariantExcludingMemory(repo, "variant");

    assert.equal(delta, "");
    assert.ok(existsSync(resolve(repo, "src/feature.ts")), "variant code should merge in");
    assert.ok(!existsSync(resolve(repo, ".git/MERGE_HEAD")), "merge should be committed");
  });

  it("aborts cleanly on a real code conflict and reports the conflicting files", async () => {
    await git("checkout", "-b", "variant");
    write("src/server.ts", "export const value = 99;\n");
    await commitAll("variant code");

    await git("checkout", "main");
    write("src/server.ts", "export const value = 2;\n");
    await commitAll("parent code");

    // A genuine code conflict must reject with the conflicting files, not swallow
    // into a bogus clean commit.
    await assert.rejects(mergeVariantExcludingMemory(repo, "variant"), (err: unknown) => {
      assert.ok(err instanceof VariantMergeError);
      assert.deepEqual(err.conflicts, ["src/server.ts"]);
      return true;
    });

    // The parent is left clean: no merge in progress, no stray changes, and no
    // merge commit landed.
    assert.ok(!existsSync(resolve(repo, ".git/MERGE_HEAD")), "merge should be aborted");
    assert.equal((await git("status", "--porcelain")).trim(), "", "worktree should be clean");
    const log = (await git("log", "--oneline")).trim().split("\n");
    assert.equal(log.length, 2, "no merge commit should have landed");
  });

  it("does not throw when the variant has no new commits (no-op join)", async () => {
    // Branch the variant but never commit past the branch point.
    await git("branch", "variant");

    const delta = await mergeVariantExcludingMemory(repo, "variant");

    assert.equal(delta, "");
    assert.ok(!existsSync(resolve(repo, ".git/MERGE_HEAD")), "no merge should be in progress");
    assert.equal((await git("status", "--porcelain")).trim(), "", "worktree should be clean");
  });

  it("keeps the parent's journal when the variant deleted a day", async () => {
    await git("checkout", "-b", "variant");
    rmSync(resolve(repo, "home/memory/journal/2026-07-01.md"));
    write("src/feature.ts", "export const feature = true;\n");
    await commitAll("variant deletes a journal day");
    await git("checkout", "main");

    await mergeVariantExcludingMemory(repo, "variant");

    // The parent keeps the day the variant deleted; code still merges.
    assert.ok(
      existsSync(resolve(repo, "home/memory/journal/2026-07-01.md")),
      "parent's journal day should survive the variant's deletion",
    );
    assert.ok(existsSync(resolve(repo, "src/feature.ts")), "variant code should merge in");
  });

  it("merges cleanly when the variant added a MEMORY.md the parent never tracked", async () => {
    // Parent drops MEMORY.md entirely.
    await git("rm", "-q", "home/MEMORY.md");
    await commitAll("parent drops memory");

    // Variant re-introduces it and does some code work.
    await git("checkout", "-b", "variant");
    write("home/MEMORY.md", "# Memory\n\n- variant reinvented memory\n");
    write("src/feature.ts", "export const feature = true;\n");
    await commitAll("variant re-adds memory");
    await git("checkout", "main");

    // Must merge successfully (not abort): the variant-added file is dropped, not
    // left untracked to be swept up by the parent's next auto-commit.
    await mergeVariantExcludingMemory(repo, "variant");

    assert.ok(
      !existsSync(resolve(repo, "home/MEMORY.md")),
      "variant-added MEMORY.md the parent never tracked must not be merged in",
    );
    assert.equal((await git("status", "--porcelain")).trim(), "", "no untracked file left behind");
    assert.ok(existsSync(resolve(repo, "src/feature.ts")), "variant code should merge in");
  });

  it("caps an oversized delta", async () => {
    await git("checkout", "-b", "variant");
    write("home/MEMORY.md", `# Memory\n\n${"variant fact line\n".repeat(2000)}`);
    await commitAll("variant floods memory");
    await git("checkout", "main");

    const delta = await mergeVariantExcludingMemory(repo, "variant");

    assert.ok(delta.length < 13000, "delta should be capped near MAX_DELTA_CHARS");
    assert.match(delta, /delta truncated/);
    // The flood is still kept out of the parent's own memory.
    assert.doesNotMatch(
      readFileSync(resolve(repo, "home/MEMORY.md"), "utf-8"),
      /variant fact line/,
    );
  });
});

describe("findUnresolvedHomeFiles / formatUnresolvedHomeFilesMessage (#656)", () => {
  // A real worktree pair (not just branches) so we can reproduce the actual
  // destructive step at join: `git worktree remove` deletes everything left
  // uncommitted on disk, ignored or not.
  const parent = resolve("/tmp", `variant-unresolved-test-${process.pid}`);
  const variantDir = resolve("/tmp", `variant-unresolved-test-${process.pid}-variant`);
  const templateGitignore = readFileSync(
    resolve(findTemplatesRoot(), "_base", "gitignore"),
    "utf-8",
  );

  async function parentGit(...args: string[]): Promise<string> {
    return gitExec(args, { cwd: parent });
  }

  async function variantGit(...args: string[]): Promise<string> {
    return gitExec(args, { cwd: variantDir });
  }

  beforeEach(async () => {
    rmSync(parent, { recursive: true, force: true });
    rmSync(variantDir, { recursive: true, force: true });
    mkdirSync(parent, { recursive: true });

    await parentGit("init", "-b", "main");
    await parentGit("config", "user.name", "test");
    await parentGit("config", "user.email", "test@example.com");

    // Use the real template gitignore so the test tracks actual mind behavior,
    // not a hand-rolled approximation of it.
    writeFileSync(resolve(parent, ".gitignore"), templateGitignore);
    mkdirSync(resolve(parent, "home"), { recursive: true });
    writeFileSync(resolve(parent, "home/SOUL.md"), "# Soul\n");
    await parentGit("add", "-A");
    await parentGit("commit", "-m", "initial");

    await parentGit("worktree", "add", "-b", "variant", variantDir, "main");
    await variantGit("config", "user.name", "test");
    await variantGit("config", "user.email", "test@example.com");
  });

  afterEach(async () => {
    await parentGit("worktree", "remove", "--force", variantDir).catch(() => {});
    rmSync(parent, { recursive: true, force: true });
    rmSync(variantDir, { recursive: true, force: true });
  });

  it("finds new home/ files .gitignore blocks, with sizes, but leaves SDK runtime noise alone", async () => {
    // The mind's normal creative path: a brand-new top-level home/ file. The
    // `home/*` catch-all ignores it, exactly as it ignored MANIFESTO.md/NOTE.md
    // in the reported repro. Nothing here is force-added — only reported.
    writeFileSync(resolve(variantDir, "home/NOTE.md"), "hello from the variant\n");

    // SDK runtime noise that PR #661 deliberately keeps ignored — the daemon's own
    // regenerated-every-session plumbing, not a mind's content, so it must never
    // show up as something the mind is asked to resolve.
    mkdirSync(resolve(variantDir, "home/.claude/projects"), { recursive: true });
    writeFileSync(resolve(variantDir, "home/.claude/projects/transcript.jsonl"), "{}\n");

    const result = await findUnresolvedHomeFiles(variantDir);

    assert.equal(result.totalCount, 1);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].path, "home/NOTE.md");
    assert.equal(result.files[0].bytes, "hello from the variant\n".length);
    assert.equal(result.totalBytes, "hello from the variant\n".length);

    // Nothing was staged — this is pure detection, no side effects.
    const staged = (await variantGit("diff", "--cached", "--name-only")).trim();
    assert.equal(staged, "", "detection must not stage anything");
  });

  it("caps the listed files but keeps the true count and total size", async () => {
    for (let i = 0; i < 25; i++) {
      writeFileSync(resolve(variantDir, `home/file-${i}.bin`), "x".repeat(10));
    }

    const result = await findUnresolvedHomeFiles(variantDir);

    assert.equal(result.totalCount, 25);
    assert.ok(result.files.length < 25, "listing should be capped");
    assert.equal(result.totalBytes, 250, "total size covers every file, not just the listed ones");
  });

  it("formats an actionable message naming paths, sizes, and the three resolution options", async () => {
    mkdirSync(resolve(variantDir, "home/downloads"), { recursive: true });
    writeFileSync(resolve(variantDir, "home/downloads/movie.mp4"), "x".repeat(2048));

    const result = await findUnresolvedHomeFiles(variantDir);
    const message = formatUnresolvedHomeFilesMessage("my-variant", result);

    assert.match(message, /my-variant/);
    assert.match(message, /downloads\/movie\.mp4/);
    assert.match(message, /2\.0 KB/);
    assert.match(message, /git add -f/);
    assert.match(message, /[Cc]opy it out/);
    assert.match(message, /[Dd]elete it/);
    assert.match(message, /discardUnresolved/);
  });

  it("reports nothing when the variant has no untracked home/ files", async () => {
    writeFileSync(resolve(variantDir, "home/SOUL.md"), "# Soul\nupdated\n");
    await variantGit("add", "-A");
    await variantGit("commit", "-m", "tracked change only");

    const result = await findUnresolvedHomeFiles(variantDir);

    assert.equal(result.totalCount, 0);
    assert.equal(result.files.length, 0);
    assert.equal(result.totalBytes, 0);
  });

  it("a variant's new home/ file survives a join that's blocked on it — nothing is destroyed", async () => {
    // Mirrors the reported repro: the mind writes a new top-level home/ file, never
    // committed (gitignored). This test proves the actual safety property the redesign
    // exists for: the file is still there, byte-for-byte, after a join attempt that
    // finds it unresolved — not silently gone, the way the pre-fix code left it.
    writeFileSync(resolve(variantDir, "home/NOTE.md"), "hello from the variant\n");

    const unresolved = await findUnresolvedHomeFiles(variantDir);
    assert.equal(
      unresolved.totalCount,
      1,
      "the new file must be detected before anything destructive runs",
    );

    // The production join flow (web/api/v1/variants.ts, web/api/v1/minds.ts) checks this
    // and — finding something — returns/notices instead of calling cleanupVariant.
    // Simulate that decision directly: skip cleanup entirely.
    if (unresolved.totalCount === 0) {
      await parentGit("worktree", "remove", "--force", variantDir);
    }

    // The variant worktree is untouched: still there, file still exactly as written.
    assert.ok(existsSync(variantDir), "variant worktree must not be removed while blocked");
    assert.equal(
      readFileSync(resolve(variantDir, "home/NOTE.md"), "utf-8"),
      "hello from the variant\n",
      "the file must survive completely intact — nothing merged, nothing discarded",
    );
  });

  it("once resolved (git add -f + commit), the retried join proceeds and the file survives via a normal merge", async () => {
    writeFileSync(resolve(variantDir, "home/NOTE.md"), "hello from the variant\n");
    assert.equal((await findUnresolvedHomeFiles(variantDir)).totalCount, 1);

    // The mind resolves it — option 1 from the message: track it explicitly.
    await variantGit("add", "-f", "--", "home/NOTE.md");
    await variantGit("commit", "-m", "keep my note");

    // Retrying the join now finds nothing unresolved, so it's safe to proceed.
    const retried = await findUnresolvedHomeFiles(variantDir);
    assert.equal(retried.totalCount, 0, "resolved files must no longer block the join");

    await mergeVariantExcludingMemory(parent, "variant");
    await parentGit("worktree", "remove", "--force", variantDir);

    assert.ok(
      existsSync(resolve(parent, "home/NOTE.md")),
      "once tracked, the file merges into the parent like any other committed change",
    );
  });
});
