import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { mergeVariant } from "../packages/daemon/src/lib/mind/lifecycle.js";

// #330: the single mergeVariant() behind both the merge route (verify:true) and the
// mind-initiated restart merge (verify:false). These drive the collapsed spine on a
// real git repo — auto-commit both sides, merge-excluding-memory, unresolved gate,
// cleanup — and assert each former call site's outcome is reproduced. verify:true's
// happy path (spawn + self-check) needs a bootable mind server and is exercised
// end-to-end by daemon-e2e; here we cover its fast failure branch.

let counter = 0;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  }).trim();
}

/**
 * A parent mind repo (main) with a variant worktree branched off it. `home/MEMORY.md`
 * is tracked so the memory-exclusion path has something to diff; a stub `node_modules`
 * keeps npmInstallNeeded from shelling out to `npm install` in the fixture.
 */
function setupRepo(): {
  baseDir: string;
  variantDir: string;
  variantName: string;
  variantBranch: string;
} {
  const n = ++counter;
  const variantName = `mv-test-variant-${Date.now()}-${n}`;
  const variantBranch = variantName;
  const baseDir = mkdtempSync(resolve(tmpdir(), "mv-test-base-"));

  git(baseDir, "init", "-q");
  mkdirSync(resolve(baseDir, "home"), { recursive: true });
  mkdirSync(resolve(baseDir, "node_modules"), { recursive: true });
  writeFileSync(resolve(baseDir, "app.txt"), "v1\n");
  writeFileSync(resolve(baseDir, "home/MEMORY.md"), "parent memory v1\n");
  writeFileSync(resolve(baseDir, ".gitignore"), "node_modules/\nhome/downloads/\n");
  git(baseDir, "add", "-A");
  git(baseDir, "commit", "-q", "-m", "initial");

  mkdirSync(resolve(baseDir, ".variants"), { recursive: true });
  const variantDir = resolve(baseDir, ".variants", variantName);
  git(baseDir, "worktree", "add", "-q", "-b", variantBranch, variantDir);

  return { baseDir, variantDir, variantName, variantBranch };
}

describe("mergeVariant (#330 unified merge)", () => {
  it("merges a clean variant, folds in the memory delta, and cleans up (verify:false)", async () => {
    const { baseDir, variantDir, variantName, variantBranch } = setupRepo();
    try {
      // Variant commits new code and edits its living memory.
      writeFileSync(resolve(variantDir, "feature.txt"), "from variant\n");
      writeFileSync(resolve(variantDir, "home/MEMORY.md"), "variant learned something\n");
      git(variantDir, "add", "-A");
      git(variantDir, "commit", "-q", "-m", "variant work");

      const result = await mergeVariant({
        parentName: "mv-parent",
        variantName,
        projectRoot: baseDir,
        variantDir,
        variantBranch,
        verify: false,
        contextExtras: { summary: "did work", justification: "why", memory: "carry this" },
      });

      assert.equal(result.status, "merged");
      if (result.status !== "merged") return; // narrow

      // Code merged into the parent...
      assert.ok(existsSync(resolve(baseDir, "feature.txt")));
      // ...but the mind's living memory is NOT line-merged — parent keeps its own,
      // the variant's version rides back as memoryDelta (#440).
      assert.equal(git(baseDir, "show", "HEAD:home/MEMORY.md"), "parent memory v1");
      assert.ok(result.memoryDelta.includes("variant learned something"));

      // Context is the ready-to-deliver merge message payload.
      assert.equal(result.context.type, "merged");
      assert.equal(result.context.name, variantName);
      assert.equal(result.context.summary, "did work");
      assert.equal(result.context.justification, "why");
      assert.equal(result.context.memory, "carry this");
      assert.ok(String(result.context.memoryDelta).includes("variant learned something"));

      // Cleanup landed: worktree gone, branch deleted.
      assert.ok(!existsSync(variantDir));
      assert.throws(() => git(baseDir, "rev-parse", "--verify", variantBranch));
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("reports a conflict and leaves the variant intact (verify:false)", async () => {
    const { baseDir, variantDir, variantName, variantBranch } = setupRepo();
    try {
      // Both sides edit the same tracked file → real merge conflict.
      writeFileSync(resolve(variantDir, "app.txt"), "variant change\n");
      git(variantDir, "add", "-A");
      git(variantDir, "commit", "-q", "-m", "variant edits app");
      writeFileSync(resolve(baseDir, "app.txt"), "parent change\n");
      git(baseDir, "add", "-A");
      git(baseDir, "commit", "-q", "-m", "parent edits app");

      const result = await mergeVariant({
        parentName: "mv-parent",
        variantName,
        projectRoot: baseDir,
        variantDir,
        variantBranch,
        verify: false,
      });

      assert.equal(result.status, "conflict");
      // Variant left fully intact for retry — worktree and branch still there.
      assert.ok(existsSync(variantDir));
      assert.equal(git(baseDir, "rev-parse", "--verify", variantBranch).length, 40);
      // Parent worktree restored — no lingering merge state.
      assert.equal(git(baseDir, "show", "HEAD:app.txt"), "parent change");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("blocks on unresolved ignored home/ files, and --discard overrides it (verify:false)", async () => {
    // Blocked case.
    {
      const { baseDir, variantDir, variantName, variantBranch } = setupRepo();
      try {
        writeFileSync(resolve(variantDir, "feature.txt"), "x\n");
        git(variantDir, "add", "-A");
        git(variantDir, "commit", "-q", "-m", "variant work");
        // An ignored, untracked file under home/ — gitignore would silently drop it.
        mkdirSync(resolve(variantDir, "home/downloads"), { recursive: true });
        writeFileSync(resolve(variantDir, "home/downloads/movie.bin"), "precious\n");

        const result = await mergeVariant({
          parentName: "mv-parent",
          variantName,
          projectRoot: baseDir,
          variantDir,
          variantBranch,
          verify: false,
        });

        assert.equal(result.status, "unresolved");
        if (result.status === "unresolved") {
          assert.equal(result.unresolved.totalCount, 1);
        }
        // Variant not cleaned up — the join can be retried after resolving.
        assert.ok(existsSync(variantDir));
      } finally {
        rmSync(baseDir, { recursive: true, force: true });
      }
    }

    // Same setup, but discardUnresolved bypasses the gate and merges.
    {
      const { baseDir, variantDir, variantName, variantBranch } = setupRepo();
      try {
        writeFileSync(resolve(variantDir, "feature.txt"), "x\n");
        git(variantDir, "add", "-A");
        git(variantDir, "commit", "-q", "-m", "variant work");
        mkdirSync(resolve(variantDir, "home/downloads"), { recursive: true });
        writeFileSync(resolve(variantDir, "home/downloads/movie.bin"), "precious\n");

        const result = await mergeVariant({
          parentName: "mv-parent",
          variantName,
          projectRoot: baseDir,
          variantDir,
          variantBranch,
          verify: false,
          discardUnresolved: true,
        });

        assert.equal(result.status, "merged");
        assert.ok(existsSync(resolve(baseDir, "feature.txt")));
        assert.ok(!existsSync(variantDir));
      } finally {
        rmSync(baseDir, { recursive: true, force: true });
      }
    }
  });

  it("returns verify_failed when the variant can't boot (verify:true)", async () => {
    const { baseDir, variantDir, variantName, variantBranch } = setupRepo();
    try {
      // No src/server.ts in the fixture, so the spawned server exits immediately and
      // spawnServer resolves null → verify_failed, before any merge is attempted.
      const result = await mergeVariant({
        parentName: "mv-parent",
        variantName,
        projectRoot: baseDir,
        variantDir,
        variantBranch,
        verify: true,
      });

      assert.equal(result.status, "verify_failed");
      // Nothing merged — variant and branch untouched.
      assert.ok(existsSync(variantDir));
      assert.equal(git(baseDir, "rev-parse", "--verify", variantBranch).length, 40);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
