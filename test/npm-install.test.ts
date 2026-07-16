import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  depsChangedSince,
  lowPriorityArgv,
  npmInstallNeeded,
} from "../packages/daemon/src/lib/mind/npm-install.js";

const tmpDir = join(tmpdir(), `.volute-npm-install-test-${process.pid}`);

function git(args: string[], cwd: string): string {
  // Strip ALL GIT_* env vars set by hooks (e.g. pre-push) that override cwd-based repo discovery
  const env: Record<string, string> = { LEFTHOOK: "0" };
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("GIT_") && v !== undefined) env[k] = v;
  }
  return execFileSync("git", args, { cwd, encoding: "utf-8", env });
}

function commit(dir: string, message: string): string {
  git(["add", "-A"], dir);
  git(["commit", "-m", message], dir);
  return git(["rev-parse", "HEAD"], dir).trim();
}

describe("lowPriorityArgv", () => {
  it("prefixes with ionice and nice when ionice is available", () => {
    const [cmd, args] = lowPriorityArgv("npm", ["install"], true);
    assert.equal(cmd, "ionice");
    assert.deepEqual(args, ["-c2", "-n7", "nice", "-n19", "npm", "install"]);
  });

  it("prefixes with nice alone when ionice is unavailable", () => {
    const [cmd, args] = lowPriorityArgv("npm", ["install"], false);
    assert.equal(cmd, "nice");
    assert.deepEqual(args, ["-n19", "npm", "install"]);
  });
});

describe("depsChangedSince / npmInstallNeeded", () => {
  const repoDir = join(tmpDir, "repo");
  let baseRef = "";

  before(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(repoDir, { recursive: true });
    git(["init", "-b", "main"], repoDir);
    git(["config", "user.email", "test@test.com"], repoDir);
    git(["config", "user.name", "Test"], repoDir);
    writeFileSync(join(repoDir, "package.json"), '{"name":"t","version":"1.0.0"}\n');
    writeFileSync(join(repoDir, "README.md"), "hi\n");
    baseRef = commit(repoDir, "initial");
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns false when only non-dependency files changed", async () => {
    writeFileSync(join(repoDir, "README.md"), "changed\n");
    commit(repoDir, "docs change");
    assert.equal(await depsChangedSince(repoDir, baseRef), false);
  });

  it("returns true when package.json changed", async () => {
    const from = git(["rev-parse", "HEAD"], repoDir).trim();
    writeFileSync(join(repoDir, "package.json"), '{"name":"t","version":"1.0.1"}\n');
    commit(repoDir, "bump");
    assert.equal(await depsChangedSince(repoDir, from), true);
  });

  it("returns true when package-lock.json changed", async () => {
    const from = git(["rev-parse", "HEAD"], repoDir).trim();
    writeFileSync(join(repoDir, "package-lock.json"), "{}\n");
    commit(repoDir, "lockfile");
    assert.equal(await depsChangedSince(repoDir, from), true);
  });

  it("errs toward true when the ref is invalid", async () => {
    assert.equal(await depsChangedSince(repoDir, "not-a-ref"), true);
  });

  it("npmInstallNeeded is true when node_modules is missing", async () => {
    const head = git(["rev-parse", "HEAD"], repoDir).trim();
    assert.equal(await npmInstallNeeded(repoDir, head), true);
  });

  it("npmInstallNeeded is false when node_modules exists and deps are unchanged", async () => {
    mkdirSync(join(repoDir, "node_modules"), { recursive: true });
    const head = git(["rev-parse", "HEAD"], repoDir).trim();
    assert.equal(await npmInstallNeeded(repoDir, head), false);
  });
});
