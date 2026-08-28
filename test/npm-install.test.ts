import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  depsChangedSince,
  isStaleCacheFailure,
  lowPriorityArgv,
  npmInstallAsMind,
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

describe("npmInstallAsMind retry", () => {
  const cwd = join(tmpDir, "install-retry");

  type Attempt = { cmd: string; args: string[] };

  /** Collect each attempt's argv; fail the given attempts (1-based) with `err`. */
  function recorder(failing: number[], err: Error) {
    const attempts: Attempt[] = [];
    const run = async (cmd: string, args: string[]) => {
      attempts.push({ cmd, args });
      if (failing.includes(attempts.length)) throw err;
      return "";
    };
    return { attempts, run };
  }

  const etarget = Object.assign(new Error("Command failed: npm install"), {
    stderr: "npm error code ETARGET\nnpm error notarget No matching version found for x@1.2.3.",
  });

  it("prefers the local cache on the first attempt", async () => {
    const { attempts, run } = recorder([], etarget);
    await npmInstallAsMind(cwd, "test-mind", run);
    assert.equal(attempts.length, 1);
    assert.ok(attempts[0].args.includes("--prefer-offline"));
  });

  it("retries without --prefer-offline when the cached resolve fails", async () => {
    const { attempts, run } = recorder([1], etarget);
    await npmInstallAsMind(cwd, "test-mind", run);
    assert.equal(attempts.length, 2);
    assert.ok(attempts[0].args.includes("--prefer-offline"));
    assert.ok(
      !attempts[1].args.includes("--prefer-offline"),
      "the retry must resolve against the registry, not the stale cache",
    );
    // The retry keeps the low-priority wrapping — that, not the cache
    // preference, is what protects slow storage.
    assert.equal(attempts[1].cmd, attempts[0].cmd);
    assert.ok(attempts[1].args.includes("install"));
  });

  it("gives up after the retry and rethrows the second failure", async () => {
    const second = Object.assign(new Error("second failure"), { stderr: "npm error E404" });
    const attempts: Attempt[] = [];
    const run = async (cmd: string, args: string[]) => {
      attempts.push({ cmd, args });
      throw attempts.length === 1 ? etarget : second;
    };
    await assert.rejects(() => npmInstallAsMind(cwd, "test-mind", run), /second failure/);
    assert.equal(attempts.length, 2);
  });

  it("does not retry a failure that has nothing to do with the cache", async () => {
    // Attempt two must reach the registry, so retrying an unreachable-network or
    // permissions failure only doubles a stall the caller is awaiting.
    const eacces = Object.assign(new Error("Command failed"), {
      stderr: "npm error code EACCES\nnpm error syscall mkdir",
    });
    const { attempts, run } = recorder([1], eacces);
    await assert.rejects(() => npmInstallAsMind(cwd, "test-mind", run), /Command failed/);
    assert.equal(attempts.length, 1, "one attempt only");
  });

  it("recognises the stale-cache signature wherever npm puts it", () => {
    assert.equal(isStaleCacheFailure({ stderr: "npm error code ETARGET" }), true);
    assert.equal(isStaleCacheFailure({ stderr: "npm error code ENOTCACHED" }), true);
    assert.equal(isStaleCacheFailure(new Error("No matching version found for x@1.0.0")), true);
    assert.equal(isStaleCacheFailure({ stderr: "npm error code EACCES" }), false);
    // A failure raised before npm ran at all has no stderr and must not qualify.
    assert.equal(isStaleCacheFailure(new Error("runuser: user mind-x does not exist")), false);
    assert.equal(isStaleCacheFailure(undefined), false);
  });
});
