import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, describe, it } from "node:test";
import { killPidTree, killTree, sweepScratch } from "./helpers/process-tree.js";

/**
 * The teardown helpers the upgrade e2e relies on (#1047). Driven with a real
 * two-level process tree, because the bug they fix is precisely that a
 * grandchild outlives a signal aimed at the pid we spawned.
 */

/** Writes its pid, then scribbles into `SCRIBBLE_DIR` forever. */
const GRANDCHILD_SRC = `
  const fs = require("node:fs");
  const dir = process.env.SCRIBBLE_DIR;
  fs.writeFileSync(dir + "/grandchild.pid", String(process.pid));
  setInterval(() => fs.appendFileSync(dir + "/scribble.log", "x"), 25);
`;

/** Spawns the grandchild (inheriting its process group) and stays alive. */
const PARENT_SRC = `
  const { spawn } = require("node:child_process");
  spawn(process.execPath, ["-e", process.env.GRANDCHILD_SRC], { stdio: "ignore" });
  setInterval(() => {}, 1000);
`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 10000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

const scratchDirs: string[] = [];
const strays: number[] = [];

/** A detached parent + its grandchild, once the grandchild has announced its pid. */
async function spawnTree(): Promise<{ dir: string; proc: ChildProcess; grandchild: number }> {
  const dir = mkdtempSync(resolve(tmpdir(), "process-tree-test-"));
  scratchDirs.push(dir);
  const proc = spawn(process.execPath, ["-e", PARENT_SRC], {
    stdio: "ignore",
    detached: true,
    env: { ...process.env, SCRIBBLE_DIR: dir, GRANDCHILD_SRC },
  });
  const pidFile = resolve(dir, "grandchild.pid");
  assert.ok(await waitFor(() => existsSync(pidFile)), "grandchild never reported its pid");
  const grandchild = Number(readFileSync(pidFile, "utf-8"));
  assert.ok(grandchild > 0, "grandchild pid should be readable");
  strays.push(grandchild);
  return { dir, proc, grandchild };
}

after(() => {
  for (const pid of strays) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  for (const dir of scratchDirs) {
    try {
      chmodSync(dir, 0o700);
    } catch {}
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("process-tree teardown helpers", () => {
  it("killTree kills the whole process group, leaving the scratch dir removable", async () => {
    const { dir, proc, grandchild } = await spawnTree();

    await killTree(proc, 5000);

    assert.ok(await waitFor(() => !alive(grandchild)), "grandchild survived killTree");
    assert.equal(proc.exitCode !== null || proc.signalCode !== null, true, "leader should be gone");

    sweepScratch(dir);
    assert.equal(existsSync(dir), false, `scratch dir should be gone: ${dir}`);
  });

  it("signalling only the spawned pid leaves the grandchild alive (the bug)", async () => {
    // The premise killTree exists for. Without the group signal, the grandchild
    // keeps writing into the scratch dir — which is how the upgrade e2e ended up
    // racing its own straggler to ENOTEMPTY.
    const { proc, grandchild } = await spawnTree();

    proc.kill("SIGTERM");
    await waitFor(() => proc.exitCode !== null || proc.signalCode !== null);

    await new Promise((r) => setTimeout(r, 500));
    assert.ok(alive(grandchild), "leader-only SIGTERM should NOT have reached the grandchild");

    await killTree(proc, 5000); // no-op on an exited leader; the after() hook reaps the stray
  });

  it("killPidTree reaps the group of a process it did not spawn", async () => {
    // How the e2e reaps a mind server orphaned by a daemon that died before it
    // could stop it: all teardown has is the pid holding the listening socket.
    const { proc, grandchild } = await spawnTree();
    const leader = proc.pid!;

    killPidTree(leader);

    assert.ok(await waitFor(() => !alive(grandchild)), "grandchild survived killPidTree");
    assert.ok(await waitFor(() => !alive(leader)), "leader survived killPidTree");
  });

  it("killPidTree leaves another group alone when the pid does not lead one", async () => {
    // The guard that keeps `kill(-pid)` off an unrelated group: the grandchild is a
    // group *member*, not its leader, so only it may be killed — never its siblings.
    const { proc, grandchild } = await spawnTree();
    const leader = proc.pid!;

    killPidTree(grandchild);

    assert.ok(await waitFor(() => !alive(grandchild)), "the targeted pid should be killed");
    assert.ok(alive(leader), "the rest of the group must be untouched");

    await killTree(proc, 5000);
  });

  it("sweepScratch warns instead of throwing when the dir cannot be removed", async (t) => {
    if (process.getuid?.() === 0) return t.skip("root ignores the directory permissions used here");

    const dir = mkdtempSync(resolve(tmpdir(), "process-tree-test-"));
    scratchDirs.push(dir);
    writeFileSync(resolve(dir, "held.txt"), "held");
    chmodSync(dir, 0o500); // no write bit: the unlink inside fails

    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
    try {
      sweepScratch(dir, 0); // must not throw — cleanup never fails a passed test
    } finally {
      console.warn = realWarn;
      chmodSync(dir, 0o700);
    }

    assert.ok(existsSync(dir), "premise: the dir really was unremovable");
    assert.ok(
      warnings.some((w) => w.includes("could not remove")),
      `expected a warning about the failed sweep, got ${JSON.stringify(warnings)}`,
    );
    assert.ok(
      warnings.some((w) => w.includes("survivor:") && w.includes("held.txt")),
      `expected the surviving path to be listed, got ${JSON.stringify(warnings)}`,
    );
  });
});
