import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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

  it("passes only overrides — the token scrub itself lives in exec (#966)", () => {
    // `exec` lays the caller's env over the mind allowlist, so an env of nothing but
    // overrides cannot reintroduce the admin token; a `...process.env` spread could.
    // test/exec-env.test.ts pins the wrapper end to end, hook and all.
    process.env.VOLUTE_DAEMON_TOKEN = "admin-secret";
    try {
      process.env.VOLUTE_ISOLATION = "user";
      assert.deepEqual(mindGitOpts("/minds/mimsy", "mimsy").env, { HOME: "/minds/mimsy/home" });
      delete process.env.VOLUTE_ISOLATION;
      assert.equal(mindGitOpts("/minds/mimsy", "mimsy").env, undefined);
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

describe("daemon git in a mind's repo runs as the mind (#961, #1284)", () => {
  // The uid itself is only observable under real per-mind users — test/docker-e2e.sh
  // Phase 7c records it from inside the mind's hooks. This pins the source side: a git
  // call that builds its own `{ cwd }` runs as the daemon — root under isolation, in a
  // repo whose hooks and config the mind writes — so none may. Options come from
  // mindGitOpts, which carries the mind's uid and HOME.
  const LIB = resolve(import.meta.dirname, "../packages/daemon/src/lib");
  const SCANNED = [
    "delivery/since-last-here.ts",
    "mind/last-known-good.ts",
    "mind/lifecycle.ts",
    "mind/npm-install.ts",
    "mind/spirit.ts",
    "mind/template-branch.ts",
    "mind/upgrade.ts",
    "mind/variant-cleanup.ts",
    "mind/variants.ts",
    "skills.ts",
  ];
  // Every other file under lib/ that runs git, and why it isn't held to the rule.
  const EXEMPT: Record<string, string> = {
    "util/exec.ts": "defines gitExec",
    // The host's own `volute mind export`, not the daemon: ls-files with the repo
    // named and fsmonitor pinned off (#1059), and sharesTemplateBase's read-only
    // rev-parse/merge-base. Nothing there commits, checks out or refreshes the index.
    "mind/archive.ts": "host-side CLI export, read-only and pinned",
  };

  // The cwd options in scanned files that are not git, counted, and why. Anything else
  // with a `cwd` key — inline, in a variable, spread over (`{ ...x, cwd }`), handed to
  // `exec("git", …)` or to a helper that forwards it — is git options not built by
  // mindGitOpts, and fails.
  const NOT_GIT: Record<string, Record<string, number>> = {
    // npm itself, in the isolation-wrapped (or unwrapped, isolation off) runner.
    "mind/npm-install.ts": { "{ cwd, env }": 2 },
    // The spirit's first npm install, as the host, before its user exists.
    "mind/spirit.ts": { "{ cwd: dir, env: hostNpmEnv() }": 1 },
    // merge-file on the daemon's own temp files, in a fresh mkdtemp dir with repo
    // discovery stopped there: no mind repo is involved.
    "skills.ts": { "{ cwd: tmpBase, env: { GIT_CEILING_DIRECTORIES: dirname(tmpBase) } }": 1 },
  };

  /** The innermost `{ … }` around every `cwd` key, whitespace collapsed. */
  function cwdObjects(source: string): string[] {
    const flat = source.replace(/\s+/g, " ");
    const found: string[] = [];
    for (const m of flat.matchAll(/[{,] ?cwd\b(?!\??: string)/g)) {
      let open = m.index;
      for (let depth = 0; open >= 0; open--) {
        if (flat[open] === "}") depth++;
        else if (flat[open] === "{" && depth-- === 0) break;
      }
      let close = m.index + 1;
      for (let depth = 0; close < flat.length; close++) {
        if (flat[close] === "{") depth++;
        else if (flat[close] === "}" && depth-- === 0) break;
      }
      found.push(flat.slice(open, close + 1));
    }
    return found;
  }

  for (const file of SCANNED) {
    it(`has no git options in ${file} that bypass mindGitOpts`, () => {
      const counts: Record<string, number> = {};
      for (const o of cwdObjects(readFileSync(resolve(LIB, file), "utf-8"))) {
        counts[o] = (counts[o] ?? 0) + 1;
      }
      assert.deepEqual(counts, NOT_GIT[file] ?? {}, "cwd options not built by mindGitOpts");
    });
  }

  it("covers every daemon file that runs git", () => {
    const runsGit = (readdirSync(LIB, { recursive: true }) as string[])
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => /gitExec\(|"git"/.test(readFileSync(resolve(LIB, f), "utf-8")))
      .sort();
    const known = [...SCANNED, ...Object.keys(EXEMPT)].sort();
    assert.deepEqual(
      runsGit.filter((f) => !known.includes(f)),
      [],
      "a new file runs git: add it to SCANNED, or to EXEMPT with the reason",
    );
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
