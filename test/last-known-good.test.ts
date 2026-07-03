import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import {
  commitSrcChanges,
  rollbackSrcChanges,
} from "../packages/daemon/src/lib/mind/last-known-good.js";

const tmpDir = join(tmpdir(), `.volute-lkg-test-${process.pid}`);
const repoDir = join(tmpDir, "mind-repo");

function git(args: string[]): string {
  const env: Record<string, string> = { LEFTHOOK: "0" };
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("GIT_") && v !== undefined) env[k] = v;
  }
  return execFileSync("git", args, { cwd: repoDir, encoding: "utf-8", env }).trim();
}

const GOOD_SERVER = "console.log('good server');\n";

function seedRepo() {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  mkdirSync(join(repoDir, "src"), { recursive: true });
  mkdirSync(join(repoDir, "home"), { recursive: true });
  git(["init", "-b", "main"]);
  git(["config", "user.email", "mind@volute"]);
  git(["config", "user.name", "mind"]);
  writeFileSync(join(repoDir, "src", "server.ts"), GOOD_SERVER);
  writeFileSync(join(repoDir, "home", "SOUL.md"), "soul\n");
  git(["add", "-A"]);
  git(["commit", "-m", "initial commit"]);
}

describe("last-known-good rollback", () => {
  beforeEach(() => {
    seedRepo();
  });

  after(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  it("reverts a broken src/ change and preserves it on a broken/* branch", async () => {
    // Mind edits its server source, breaking it (uncommitted, as auto-commit ignores src/)
    writeFileSync(join(repoDir, "src", "server.ts"), "this is broken !@#$\n");

    const result = await rollbackSrcChanges(repoDir);

    assert.equal(result.parked, true, "should report a parked change");
    assert.ok(
      result.branch?.startsWith("broken/"),
      `expected broken/* branch, got ${result.branch}`,
    );

    // Working tree src/ restored to the last known-good HEAD version
    assert.equal(
      readFileSync(join(repoDir, "src", "server.ts"), "utf-8"),
      GOOD_SERVER,
      "working tree src/server.ts should be restored to HEAD",
    );

    // Working tree is clean under src/ (nothing uncommitted after rollback)
    assert.equal(git(["status", "--porcelain", "--", "src"]), "", "src/ should be clean");

    // The broken change is preserved on the broken/* branch
    const branch = result.branch!;
    const brokenContent = git(["show", `${branch}:src/server.ts`]);
    assert.ok(brokenContent.includes("this is broken"), "broken branch should hold the bad change");

    // HEAD (main) still has the good version — the branch pointer wasn't advanced
    assert.equal(git(["show", "HEAD:src/server.ts"]), GOOD_SERVER.trim());
  });

  it("preserves uncommitted home/ changes when rolling back src/", async () => {
    // A concurrent (mid-turn) edit to home/ must survive the src/ rollback
    writeFileSync(join(repoDir, "home", "SOUL.md"), "new identity\n");
    writeFileSync(join(repoDir, "src", "server.ts"), "broken\n");

    const result = await rollbackSrcChanges(repoDir);
    assert.equal(result.parked, true);

    assert.equal(
      readFileSync(join(repoDir, "home", "SOUL.md"), "utf-8"),
      "new identity\n",
      "uncommitted home/ change should be preserved",
    );
    assert.equal(readFileSync(join(repoDir, "src", "server.ts"), "utf-8"), GOOD_SERVER);
  });

  it("drops a newly-added broken src/ file on rollback", async () => {
    writeFileSync(join(repoDir, "src", "extra.ts"), "syntax ??? error\n");

    const result = await rollbackSrcChanges(repoDir);
    assert.equal(result.parked, true);

    assert.equal(
      existsSync(join(repoDir, "src", "extra.ts")),
      false,
      "newly-added broken file should be removed from the working tree",
    );
    // ...but preserved on the broken branch
    assert.ok(git(["show", `${result.branch}:src/extra.ts`]).includes("syntax"));
  });

  it("is a no-op when src/ is clean", async () => {
    const result = await rollbackSrcChanges(repoDir);
    assert.equal(result.parked, false);
    assert.equal(result.branch, undefined);
    // No broken/* branches created
    assert.equal(git(["branch", "--list", "broken/*"]), "");
  });

  it("commitSrcChanges advances HEAD so the next rollback restores the new baseline", async () => {
    // Mind makes a good src/ edit and restarts successfully — commit it as new baseline
    const NEW_GOOD = "console.log('v2');\n";
    writeFileSync(join(repoDir, "src", "server.ts"), NEW_GOOD);
    await commitSrcChanges(repoDir);
    assert.equal(git(["show", "HEAD:src/server.ts"]), NEW_GOOD.trim());
    assert.equal(
      git(["status", "--porcelain", "--", "src"]),
      "",
      "src/ should be clean after commit",
    );

    // Now a later bad edit rolls back to the v2 baseline, not the original
    writeFileSync(join(repoDir, "src", "server.ts"), "broken again\n");
    const result = await rollbackSrcChanges(repoDir);
    assert.equal(result.parked, true);
    assert.equal(readFileSync(join(repoDir, "src", "server.ts"), "utf-8"), NEW_GOOD);
  });

  it("commitSrcChanges is a no-op when src/ is clean", async () => {
    const before = git(["rev-parse", "HEAD"]);
    await commitSrcChanges(repoDir);
    assert.equal(git(["rev-parse", "HEAD"]), before, "no commit should be created");
  });

  it("parks on a collision-proof branch name (timestamp + random suffix)", async () => {
    writeFileSync(join(repoDir, "src", "server.ts"), "broken\n");
    const result = await rollbackSrcChanges(repoDir);
    assert.equal(result.parked, true);
    // A second-resolution timestamp alone can collide across concurrent variants, so the
    // name must carry a random suffix (8 hex chars).
    assert.match(
      result.branch!,
      /^broken\/.+-[0-9a-f]{8}$/,
      `expected a random suffix, got ${result.branch}`,
    );
  });

  it("rewinds HEAD before parking so a failed branch step stays recoverable", async () => {
    // Occupy the `broken` ref name so `git branch broken/<...>` hits a D/F conflict and
    // fails — simulating any transient failure of the fragile branch-creation step.
    git(["branch", "broken"]);
    const goodHead = git(["rev-parse", "HEAD"]);
    writeFileSync(join(repoDir, "src", "server.ts"), "broken change\n");

    await assert.rejects(rollbackSrcChanges(repoDir), "branch creation should fail");

    // HEAD must be rewound to the good state — NOT left advanced on the broken commit,
    // which would make hasSrcChanges() see a clean tree and skip rollback forever.
    assert.equal(git(["rev-parse", "HEAD"]), goodHead, "HEAD should be back at the good commit");
    assert.equal(git(["show", "HEAD:src/server.ts"]), GOOD_SERVER.trim());
    // The broken change is still in the working tree, so the next restart retries rollback.
    assert.equal(readFileSync(join(repoDir, "src", "server.ts"), "utf-8"), "broken change\n");
  });

  it("commitSrcChanges does not sweep in pre-staged non-src content", async () => {
    // Something non-src is already staged in the index (e.g. a mid-turn home/ edit)
    writeFileSync(join(repoDir, "home", "SOUL.md"), "staged identity\n");
    git(["add", "--", "home/SOUL.md"]);
    // A good src/ edit to commit as the new baseline
    const NEW_GOOD = "console.log('v2');\n";
    writeFileSync(join(repoDir, "src", "server.ts"), NEW_GOOD);

    await commitSrcChanges(repoDir);

    // The baseline commit captures src/ ...
    assert.equal(git(["show", "HEAD:src/server.ts"]), NEW_GOOD.trim());
    // ... but NOT the pre-staged home/ content
    assert.equal(git(["show", "HEAD:home/SOUL.md"]), "soul", "home/ change must not be committed");
    // ... which remains staged/uncommitted for the mind's own auto-commit to handle
    assert.notEqual(
      git(["status", "--porcelain", "--", "home/SOUL.md"]),
      "",
      "home/ change should still be pending",
    );
  });

  it("rollbackSrcChanges does not sweep in pre-staged non-src content", async () => {
    writeFileSync(join(repoDir, "home", "SOUL.md"), "staged identity\n");
    git(["add", "--", "home/SOUL.md"]);
    writeFileSync(join(repoDir, "src", "server.ts"), "broken\n");

    const result = await rollbackSrcChanges(repoDir);
    assert.equal(result.parked, true);

    // The parked (broken) commit holds src/ but not the pre-staged home/ content
    assert.equal(git(["show", `${result.branch}:home/SOUL.md`]), "soul");
    // The home/ change survives untouched in the working tree
    assert.equal(readFileSync(join(repoDir, "home", "SOUL.md"), "utf-8"), "staged identity\n");
  });
});
