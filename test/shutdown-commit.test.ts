import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { MIND_STOP_GRACE_MS } from "../packages/daemon/src/lib/daemon/mind-manager.js";
import { SHUTDOWN_BUDGET_MS } from "../templates/_base/src/lib/startup.js";

// #1206: claude and pi start their turn-end commit after `done`, so a stop that follows
// `done` closely signals the mind's whole process group — the commit's git included —
// mid-flight. The files that commit carried are no longer pending by then; the shutdown
// flush has to ask git again or they stay uncommitted. This drives the real shared
// modules in a child, killed the way MindManager stops a mind: SIGTERM to its group.

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

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "volute-shutdown-commit-"));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("redoes a turn-end commit that the stop's group SIGTERM killed mid-flight", async () => {
    const home = join(dir, "home");
    mkdirSync(home);
    git(["init", "-b", "main"], home);
    git(["config", "user.email", "test@test.com"], home);
    git(["config", "user.name", "Test"], home);
    writeFileSync(join(home, "SOUL.md"), "soul");
    git(["add", "-A"], home);
    git(["commit", "-m", "initial"], home);

    // The first commit hangs in its pre-commit hook (and so is still in flight when the
    // stop lands); any later one goes straight through.
    const started = join(dir, "hook-started");
    const hangOnce = join(dir, "hang-once");
    writeFileSync(hangOnce, "");
    const hook = join(home, ".git", "hooks", "pre-commit");
    writeFileSync(
      hook,
      // `started` only once the sleep exists, so the group signal is sure to reach it.
      `#!/bin/sh\nif [ -f "${hangOnce}" ]; then rm "${hangOnce}"; sleep 30 & touch "${started}"; wait; fi\nexit 0\n`,
    );
    chmodSync(hook, 0o755);

    const script = join(dir, "mind.ts");
    writeFileSync(
      script,
      `import { flushFileChanges, trackFileChange } from ${JSON.stringify(`${BASE}/auto-commit.ts`)};
import { commitHomeChanges } from ${JSON.stringify(`${BASE}/home-changes.ts`)};
import { setupShutdown } from ${JSON.stringify(`${BASE}/startup.ts`)};
const home = ${JSON.stringify(home)};
setupShutdown(() => commitHomeChanges(home));
// A turn edited SOUL.md, emitted done, and started its commit without awaiting it.
trackFileChange("SOUL.md", home);
void flushFileChanges(home);
setInterval(() => {}, 1000);
`,
    );

    writeFileSync(join(home, "SOUL.md"), "soul, revised");
    const child = spawn(process.execPath, ["--import", "tsx", script], {
      detached: true,
      stdio: "ignore",
    });
    const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));

    const deadline = Date.now() + 15_000;
    while (!existsSync(started) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(existsSync(started), "the turn-end commit never started");

    // What MindManager's stop does.
    process.kill(-child.pid!, "SIGTERM");
    assert.equal(await exited, 0);

    assert.equal(git(["status", "--porcelain"], home), "", "the edit was left uncommitted");
    assert.match(git(["log", "-1", "--format=%s"], home), /SOUL\.md/);
  });

  it("the templates' shutdown budget ends before the daemon's SIGKILL grace", () => {
    // Otherwise a slow shutdown commit is killed mid-write by the stop it is answering.
    assert.ok(SHUTDOWN_BUDGET_MS < MIND_STOP_GRACE_MS);
  });
});
