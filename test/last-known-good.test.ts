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

const tmpDir = join(tmpdir(), ".volute-lkg-test");
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
});
