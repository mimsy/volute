import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { exec, gitExec } from "../packages/daemon/src/lib/util/exec.js";
import {
  addPagesWorktree,
  ensurePagesRepo,
  pagesPullAndMerge,
} from "../packages/extensions/pages/src/shared-pages.js";

// #966: a mind can author git hooks in its own repo, and the daemon runs `git commit`
// and `git merge` there — as root under user isolation, as the daemon's own user
// otherwise. Whatever environment those children inherit, a hook can read. These
// tests plant a hook that records what it saw and assert the admin token and an
// ambient host secret never reach it, through each wrapper the daemon spawns with.

/** A hooks dir whose pre-commit writes the two secrets it can see to `outFile`. */
function plantPreCommitHook(hooksDir: string, outFile: string): void {
  mkdirSync(hooksDir, { recursive: true });
  const hook = join(hooksDir, "pre-commit");
  // Bracketed so an empty value is still visible as `[]`.
  writeFileSync(
    hook,
    `#!/bin/sh\nprintf 'token=[%s]\\nhost=[%s]' "$VOLUTE_DAEMON_TOKEN" "$HOST_ONLY_SECRET" > "${outFile}"\n`,
  );
  chmodSync(hook, 0o755);
}

function readHookOutput(outFile: string): string {
  return readFileSync(outFile, "utf-8");
}

describe("exec env scrub (#966)", () => {
  let base: string;
  const saved = {
    token: process.env.VOLUTE_DAEMON_TOKEN,
    host: process.env.HOST_ONLY_SECRET,
    allowed: process.env.VOLUTE_EXEC_ENV_PROBE,
  };

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "exec-env-"));
    process.env.VOLUTE_DAEMON_TOKEN = "super-secret-admin";
    process.env.HOST_ONLY_SECRET = "ambient-host-secret";
    // An allowlisted var (VOLUTE_*, minus the token) — the half of the contract a
    // token-only assertion can't see, since passing no env at all also hides the token.
    process.env.VOLUTE_EXEC_ENV_PROBE = "allowlisted";
  });

  afterEach(() => {
    if (saved.token === undefined) delete process.env.VOLUTE_DAEMON_TOKEN;
    else process.env.VOLUTE_DAEMON_TOKEN = saved.token;
    if (saved.host === undefined) delete process.env.HOST_ONLY_SECRET;
    else process.env.HOST_ONLY_SECRET = saved.host;
    if (saved.allowed === undefined) delete process.env.VOLUTE_EXEC_ENV_PROBE;
    else process.env.VOLUTE_EXEC_ENV_PROBE = saved.allowed;
  });

  it("a git hook run by gitExec cannot see the daemon token", async () => {
    const repo = join(base, "repo");
    mkdirSync(repo);
    await gitExec(["init", "-q"], { cwd: repo });
    await gitExec(["config", "user.name", "test"], { cwd: repo });
    await gitExec(["config", "user.email", "test@example.com"], { cwd: repo });
    const outFile = join(base, "seen.txt");
    plantPreCommitHook(join(base, "hooks"), outFile);
    await gitExec(["config", "core.hooksPath", join(base, "hooks")], { cwd: repo });

    writeFileSync(join(repo, "a.txt"), "a\n");
    await gitExec(["add", "-A"], { cwd: repo });
    await gitExec(["commit", "-q", "-m", "hooked"], { cwd: repo });

    assert.equal(readHookOutput(outFile), "token=[]\nhost=[]");
  });

  it("a caller's env overrides land on top of the scrubbed base, not on process.env", async () => {
    const out = await exec(
      "sh",
      [
        "-c",
        'printf "token=[%s] host=[%s] extra=[%s] allowed=[%s]" "$VOLUTE_DAEMON_TOKEN" "$HOST_ONLY_SECRET" "$EXTRA" "$VOLUTE_EXEC_ENV_PROBE"',
      ],
      { env: { EXTRA: "given" } },
    );
    // Both halves matter. The empty token and host say the daemon environment was
    // not inherited; `allowed` says the allowlisted base was still laid down under
    // the override, rather than the child getting the override alone. (Don't probe
    // $PATH for that — an unset PATH is not observable here, because sh supplies
    // its own default.)
    assert.equal(out, "token=[] host=[] extra=[given] allowed=[allowlisted]");
  });

  it("strips the token even when the caller's own env puts it back", async () => {
    // The defeat the wrapper has to survive: `{ ...process.env, HOME }` was the exact
    // shape deleted from five lifecycle.ts call sites, and nothing stops someone
    // typing it again. A default a call site can quietly undo is the original bug.
    const out = await exec("sh", ["-c", 'printf "token=[%s]" "$VOLUTE_DAEMON_TOKEN"'], {
      env: { ...process.env, HOME: "/tmp" },
    });
    assert.equal(out, "token=[]");
  });

  it("a timed child gets the same scrub as an untimed one (#989)", async () => {
    // `timeout` routes through a different code path — its own `spawn`, not
    // `execFile` — and that path has to be handed the env the wrapper scrubbed
    // rather than the caller's raw one. It is the path scheduled mind scripts and
    // the wake hook take, so it is the one where mind-authored code actually runs.
    const out = await exec(
      "sh",
      [
        "-c",
        'printf "token=[%s] host=[%s] extra=[%s] allowed=[%s]" "$VOLUTE_DAEMON_TOKEN" "$HOST_ONLY_SECRET" "$EXTRA" "$VOLUTE_EXEC_ENV_PROBE"',
      ],
      { env: { EXTRA: "given" }, timeout: 10_000 },
    );
    assert.equal(out, "token=[] host=[] extra=[given] allowed=[allowlisted]");
  });

  it("a timed child cannot re-admit the token through the caller's own env", async () => {
    const out = await exec("sh", ["-c", 'printf "token=[%s]" "$VOLUTE_DAEMON_TOKEN"'], {
      env: { ...process.env, HOME: "/tmp" },
      timeout: 10_000,
    });
    assert.equal(out, "token=[]");
  });

  it("the pages extension's shared-repo commits cannot see the daemon token", async () => {
    const dataDir = join(base, "data");
    const mindDir = join(base, "alpha");
    mkdirSync(dataDir, { recursive: true });
    await ensurePagesRepo(dataDir);
    // core.hooksPath in the central repo's config applies to every worktree of it.
    const outFile = join(base, "seen.txt");
    plantPreCommitHook(join(base, "hooks"), outFile);
    await gitExec(["config", "core.hooksPath", join(base, "hooks")], {
      cwd: join(dataDir, "repo"),
    });
    await addPagesWorktree("alpha", mindDir, dataDir);

    mkdirSync(join(mindDir, "home/pages/_system"), { recursive: true });
    writeFileSync(join(mindDir, "home/pages/_system/lore.md"), "# Lore\n");
    const r = await pagesPullAndMerge("alpha", mindDir, dataDir, "start lore");
    assert.equal(r.ok, true, JSON.stringify(r));

    assert.equal(readHookOutput(outFile), "token=[]\nhost=[]");
  });
});

/**
 * The runtime tests above prove the wrapper scrubs. This one guards the other
 * direction: a child spawned *around* the wrapper, with the daemon environment
 * spread into it by hand. That is how #966 existed in the first place — five
 * `{ ...process.env, HOME }` spreads that each looked locally reasonable — and
 * the module-local `git()` helper that used to make upgrade.ts greppable is gone
 * now that the scrub is the default. So the grep lives here instead, where a new
 * spread fails CI rather than waiting to be noticed in review.
 */
describe("no stray daemon-env spreads (#966)", () => {
  const repoRoot = resolve(import.meta.dirname, "..");

  /**
   * Spreads that are deliberate and stay. Each runs a host binary on no mind's
   * behalf, or hands the token to daemon-owned code on purpose:
   *  - restic.ts     — needs the host's own backup-store credentials (AWS_*, B2_*)
   *  - bridge-manager — hands a bridge the admin token by design; not mind code
   *  - preview.ts    — chromium rendering a page; renderer JS cannot read env
   */
  const ALLOWED = new Set([
    "packages/daemon/src/lib/backup/restic.ts",
    "packages/daemon/src/lib/daemon/bridge-manager.ts",
    "packages/extensions/pages/src/preview.ts",
  ]);

  function* walk(dir: string): Generator<string> {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) yield* walk(full);
      else if (full.endsWith(".ts") && !full.endsWith(".d.ts")) yield full;
    }
  }

  it("only the documented call sites spread the daemon environment", () => {
    const offenders: string[] = [];
    for (const base of ["packages/daemon/src/lib", "packages/extensions"]) {
      for (const file of walk(join(repoRoot, base))) {
        const rel = relative(repoRoot, file).split(sep).join("/");
        if (ALLOWED.has(rel)) continue;
        readFileSync(file, "utf-8")
          .split("\n")
          .forEach((line, i) => {
            const code = line.trim();
            // Prose about the rule is not a violation of it — this file and
            // exec.ts/mind-env.ts explain the spread in comments.
            if (code.startsWith("*") || code.startsWith("//") || code.startsWith("/*")) return;
            if (code.includes("...process.env")) offenders.push(`${rel}:${i + 1}`);
          });
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `these spread the daemon environment (token included) into a child:\n  ${offenders.join("\n  ")}\n` +
        "Pass only the variables the child needs; exec/gitExec supply the scrubbed base. " +
        "If the site is genuinely host-facing, add it to ALLOWED with the reason.",
    );
  });
});
