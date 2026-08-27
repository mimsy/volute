import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { failureDetail } from "../packages/daemon/src/lib/daemon/auto-upgrade.js";
import { npmInstallEnv } from "../packages/daemon/src/lib/mind/npm-install.js";
import { addMind, mindDir, removeMind } from "../packages/daemon/src/lib/mind/registry.js";
import { mindGitOpts, runUpgrade } from "../packages/daemon/src/lib/mind/upgrade.js";

/** What the fixture's pre-commit hook prints when it refuses — mimsy's wall, in miniature. */
const REFUSAL = "wall: MEMORY.md is over the load line - refusing this commit";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

/**
 * A mind repo whose own pre-commit hook refuses any commit made while
 * `home/MEMORY.md` is present in the working tree — the shape of the wall the
 * mind mimsy pointed `core.hooksPath` at on bardo. The template-branch worktree
 * wipes home/ before committing, so only the *upgrade* worktree's commits trip it.
 */
function makeRefusingMind(name: string): string {
  const dir = mindDir(name);
  mkdirSync(resolve(dir, "home"), { recursive: true });
  writeFileSync(resolve(dir, "package.json"), JSON.stringify({ name, version: "0.0.0" }));
  writeFileSync(resolve(dir, "home", "SOUL.md"), "# soul\n");
  writeFileSync(resolve(dir, "home", "MEMORY.md"), "# memory\n");
  writeFileSync(resolve(dir, "home", "VOLUTE.md"), "# volute\n");

  git(["init", "-b", "main"], dir);
  git(["config", "user.email", "mind@test"], dir);
  git(["config", "user.name", name], dir);
  git(["add", "-A"], dir);
  git(["commit", "-m", "initial commit"], dir);

  const hooksDir = resolve(dir, "home", "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const hook = resolve(hooksDir, "pre-commit");
  writeFileSync(
    hook,
    `#!/bin/sh\nif [ -f "$(git rev-parse --show-toplevel)/home/MEMORY.md" ]; then\n  echo "${REFUSAL}" >&2\n  exit 1\nfi\nexit 0\n`,
  );
  chmodSync(hook, 0o755);
  git(["config", "core.hooksPath", hooksDir], dir);
  return dir;
}

let counter = 0;
const created: string[] = [];
function uniqueMind(): string {
  counter += 1;
  const name = `upgfail-${process.pid}-${counter}`;
  created.push(name);
  return name;
}

describe("upgrade failure cleanup", () => {
  afterEach(async () => {
    for (const name of created.splice(0)) await removeMind(name).catch(() => {});
  });

  it("surfaces the refusing hook's stderr and leaves no root-created worktree behind", async () => {
    const name = uniqueMind();
    const dir = makeRefusingMind(name);
    await addMind(name, 4199, undefined, "claude");

    const err = await runUpgrade(name, { restart: false }).then(
      () => null,
      (e: unknown) => e,
    );

    assert.ok(err, "an upgrade the mind's own hook refuses must not report success");
    assert.match(
      failureDetail(err),
      new RegExp(REFUSAL),
      "the failure must carry the hook's own words — that text is the whole fix",
    );

    // The daemon creates both of these as root on a production host. Anything left
    // here is a root-owned path inside a mind-owned repo, which silently breaks the
    // mind's own git (#497, #653) and is re-created by every later hourly pass.
    assert.equal(
      existsSync(resolve(dir, ".variants", "upgrade")),
      false,
      ".variants/upgrade must not survive a failed upgrade",
    );
    assert.equal(
      existsSync(resolve(dir, ".git", "worktrees", "upgrade")),
      false,
      ".git/worktrees/upgrade must not survive a failed upgrade",
    );
  });
});

describe("mindGitOpts", () => {
  const previous = process.env.VOLUTE_ISOLATION;
  afterEach(() => {
    if (previous === undefined) delete process.env.VOLUTE_ISOLATION;
    else process.env.VOLUTE_ISOLATION = previous;
  });

  it("runs as the mind, with the mind's HOME, under user isolation", () => {
    process.env.VOLUTE_ISOLATION = "user";
    const opts = mindGitOpts("/minds/mimsy", "mimsy");
    assert.equal(opts.cwd, "/minds/mimsy");
    assert.equal(
      opts.mindName,
      "mimsy",
      "a commit runs the mind's hooks; they must not run as the daemon",
    );
    assert.equal(opts.env?.HOME, "/minds/mimsy/home");
  });

  it("never hands the daemon's admin token to the mind's hooks", () => {
    process.env.VOLUTE_ISOLATION = "user";
    process.env.VOLUTE_DAEMON_TOKEN = "admin-secret";
    try {
      const opts = mindGitOpts("/minds/mimsy", "mimsy");
      assert.equal(
        opts.env?.VOLUTE_DAEMON_TOKEN,
        undefined,
        "a pre-commit hook the mind wrote would otherwise read the admin token",
      );
      assert.ok(opts.env?.PATH, "but it still needs enough environment to find git");
    } finally {
      delete process.env.VOLUTE_DAEMON_TOKEN;
    }
  });

  it("still scrubs the environment when there is no isolation", () => {
    // sandbox/none is the DEFAULT local mode, and it is the worse case, not the
    // safer one: the hook runs as the daemon's own user, outside the mind's sandbox.
    // A bare { cwd } would inherit the whole daemon environment, token included.
    delete process.env.VOLUTE_ISOLATION;
    process.env.VOLUTE_DAEMON_TOKEN = "admin-secret";
    try {
      const opts = mindGitOpts("/minds/mimsy", "mimsy");
      assert.equal(opts.cwd, "/minds/mimsy");
      assert.equal(opts.mindName, undefined, "there is no other uid to switch to");
      assert.equal(opts.env?.VOLUTE_DAEMON_TOKEN, undefined);
      assert.ok(opts.env, "an env must be passed, or the child inherits everything");
    } finally {
      delete process.env.VOLUTE_DAEMON_TOKEN;
    }
  });

  it("leaves HOME alone without isolation, so git can still resolve an identity", () => {
    // Redirecting HOME here would drop ~/.gitconfig out of git's config resolution
    // and break commits in any repo without a per-repo user.name.
    delete process.env.VOLUTE_ISOLATION;
    const opts = mindGitOpts("/minds/mimsy", "mimsy");
    assert.notEqual(opts.env?.HOME, "/minds/mimsy/home");
  });
});

describe("npmInstallEnv", () => {
  const previous = process.env.VOLUTE_ISOLATION;
  afterEach(() => {
    if (previous === undefined) delete process.env.VOLUTE_ISOLATION;
    else process.env.VOLUTE_ISOLATION = previous;
    delete process.env.VOLUTE_DAEMON_TOKEN;
  });

  it("never hands the daemon's admin token to a package's lifecycle scripts", () => {
    // preinstall/postinstall come from the mind's own package.json, and runuser
    // passes the environment it is given straight through to them.
    process.env.VOLUTE_DAEMON_TOKEN = "admin-secret";
    for (const mode of ["user", undefined] as const) {
      if (mode) process.env.VOLUTE_ISOLATION = mode;
      else delete process.env.VOLUTE_ISOLATION;
      const env = npmInstallEnv("/minds/mimsy");
      assert.equal(
        env.VOLUTE_DAEMON_TOKEN,
        undefined,
        `token must not leak with isolation=${mode ?? "none"}`,
      );
      assert.ok(env.PATH, "npm still needs enough environment to run");
    }
  });

  it("redirects HOME to the mind's home only under isolation", () => {
    process.env.VOLUTE_ISOLATION = "user";
    assert.equal(npmInstallEnv("/minds/mimsy").HOME, "/minds/mimsy/home");
    delete process.env.VOLUTE_ISOLATION;
    assert.notEqual(npmInstallEnv("/minds/mimsy").HOME, "/minds/mimsy/home");
  });
});
