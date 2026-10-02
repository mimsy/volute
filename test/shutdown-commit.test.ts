import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";

// #1206: claude and pi start their turn-end commit after `done`, so a stop that follows
// `done` closely signals the mind's whole process group — the commit's git included —
// mid-flight. The killed commit re-queues its files, and the shutdown drain retries them. This drives the real shared modules in a child, killed
// the way the daemon stops a mind: SIGTERM to its process group.

const BASE = resolve(import.meta.dirname, "../templates/_base/src/lib");

function git(args: string[], cwd: string): string {
  const env: Record<string, string> = { LEFTHOOK: "0" };
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("GIT_") && v !== undefined) env[k] = v;
  }
  return execFileSync("git", args, { cwd, encoding: "utf-8", env });
}

describe("shutdown commit (#1206)", () => {
  let dir: string;
  let child: ChildProcess | undefined;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "volute-shutdown-commit-"));
  });

  after(() => {
    // Never leave the child (or its hook's sleep) running past a failed assertion.
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("retries a turn-end commit that the stop's group SIGTERM killed mid-flight", async () => {
    const home = join(dir, "home");
    mkdirSync(home);
    git(["init", "-b", "main"], home);
    git(["config", "user.email", "test@test.com"], home);
    git(["config", "user.name", "Test"], home);
    writeFileSync(join(home, "SOUL.md"), "soul");
    git(["add", "-A"], home);
    git(["commit", "-m", "initial"], home);

    // The first commit hangs in its pre-commit hook, so it is still in flight when the
    // stop lands; any later one goes straight through. `started` only once the sleep
    // exists, so the group signal is sure to reach it.
    const started = join(dir, "hook-started");
    const hangOnce = join(dir, "hang-once");
    writeFileSync(hangOnce, "");
    const hook = join(home, ".git", "hooks", "pre-commit");
    writeFileSync(
      hook,
      `#!/bin/sh\nif [ -f "${hangOnce}" ]; then rm "${hangOnce}"; sleep 30 & touch "${started}"; wait; fi\nexit 0\n`,
    );
    chmodSync(hook, 0o755);

    // The claude/pi shutdown path, over the real shared modules.
    const script = join(dir, "mind.ts");
    writeFileSync(
      script,
      `import { drainFileChanges, flushFileChanges, trackFileChange } from ${JSON.stringify(`${BASE}/auto-commit.ts`)};
import { setupShutdown } from ${JSON.stringify(`${BASE}/startup.ts`)};
const home = ${JSON.stringify(home)};
setupShutdown(() => drainFileChanges(home));
// A turn edited SOUL.md, emitted done, and started its commit without awaiting it.
trackFileChange("SOUL.md", home);
void flushFileChanges(home);
setInterval(() => {}, 1000);
`,
    );

    writeFileSync(join(home, "SOUL.md"), "soul, revised");
    child = spawn(process.execPath, ["--import", "tsx", script], {
      detached: true,
      stdio: "ignore",
    });
    const proc = child;
    const exited = new Promise<number | null>((r) => proc.on("exit", (code) => r(code)));

    const deadline = Date.now() + 15_000;
    while (!existsSync(started) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(existsSync(started), "the turn-end commit never started");

    // What the daemon's stop does.
    process.kill(-proc.pid!, "SIGTERM");
    assert.equal(await exited, 0);

    assert.equal(git(["status", "--porcelain"], home), "", "the edit was left uncommitted");
    assert.equal(git(["log", "-1", "--format=%s"], home).trim(), "Update SOUL.md");
  });
});
