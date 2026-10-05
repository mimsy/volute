import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, describe, it } from "node:test";
import { exec } from "../packages/daemon/src/lib/util/exec.js";
import log from "../packages/daemon/src/lib/util/logger.js";
import {
  childrenOf,
  groupMembers,
  isRunuser,
  stopGroup,
  terminateGroup,
} from "../packages/daemon/src/lib/util/process-group.js";
import {
  stopTrackedChildren,
  trackChild,
  trackedChildren,
} from "../packages/daemon/src/lib/util/tracked-children.js";

const tempDirs: string[] = [];
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

type FakeProc = { comm: string; pgrp: number; children?: number[]; start?: number };

function writeStat(dir: string, pid: number, p: FakeProc): void {
  // state ppid pgrp session tty tpgid flags, 12 counters, then starttime (field 22)
  const start = p.start ?? pid;
  writeFileSync(
    resolve(dir, String(pid), "stat"),
    `${pid} (${p.comm}) S 1 ${p.pgrp} ${p.pgrp} 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 ${start} 0 0\n`,
  );
}

/** A fake /proc: `pid → process`; a process's start time is its pid unless given. */
function fakeProc(procs: Record<number, FakeProc>): string {
  const dir = tempDir("fake-proc-");
  for (const [key, p] of Object.entries(procs)) {
    const task = resolve(dir, key, "task", key);
    mkdirSync(task, { recursive: true });
    writeStat(dir, Number(key), p);
    writeFileSync(resolve(dir, key, "comm"), `${p.comm}\n`);
    writeFileSync(resolve(task, "children"), (p.children ?? []).map((c) => `${c} `).join(""));
  }
  mkdirSync(resolve(dir, "self"));
  mkdirSync(resolve(dir, "77")); // a pid that exited mid-scan: no stat
  return dir;
}

/** The usual isolated mind: runuser leads, node below it, the SDK below node. */
const mindTree = (): Record<number, FakeProc> => ({
  100: { comm: "runuser", pgrp: 100, children: [101] },
  101: { comm: "node", pgrp: 100, children: [102] },
  // comm can hold spaces and parens; fields are counted from the last ')'
  102: { comm: "claude (sdk) 7 9", pgrp: 100 },
  // a `nohup … &` worker reparented to init, still in the mind's group
  301: { comm: "worker", pgrp: 100 },
  // another group entirely
  400: { comm: "unrelated", pgrp: 999 },
});

function recorder(fail?: (pid: number, sig: string) => Error | undefined) {
  const sent: [number, string][] = [];
  const kill = (pid: number, sig: string | 0) => {
    const err = fail?.(pid, String(sig));
    if (err) throw err;
    if (sig !== 0) sent.push([pid, sig]);
  };
  return { sent, kill };
}

const errno = (code: string) => Object.assign(new Error(`kill ${code}`), { code });

function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  log.setOutput((line) => lines.push(line));
  return { lines, restore: () => log.setOutput((line) => process.stderr.write(`${line}\n`)) };
}

const byPid = (a: [number, string], b: [number, string]) => a[0] - b[0];

const fakeChild = (pid: number) => {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  Object.assign(child, { pid, exitCode: null, signalCode: null });
  return child;
};

describe("groupMembers", () => {
  it("finds every process in the group, reparented ones included", async () => {
    const members = await groupMembers(100, { procDir: fakeProc(mindTree()), exclude: 100 });
    assert.deepEqual(
      members.map((m) => m.pid).sort((a, b) => a - b),
      [101, 102, 301],
    );
    assert.equal(members.find((m) => m.pid === 101)?.start, "101");
  });

  it("throws when /proc can't be read, or a stat can't for a reason other than exit", async () => {
    await assert.rejects(groupMembers(100, { procDir: "/nonexistent-proc" }));
    const proc = fakeProc({ 100: { comm: "node", pgrp: 100 } });
    mkdirSync(resolve(proc, "55", "stat"), { recursive: true }); // EISDIR
    await assert.rejects(groupMembers(100, { procDir: proc }), /EISDIR/);
  });
});

describe("childrenOf / isRunuser", () => {
  it("lists a process's live children and recognises runuser", async () => {
    const proc = fakeProc({
      ...mindTree(),
      100: { comm: "runuser", pgrp: 100, children: [101, 88] },
    });
    assert.deepEqual(await childrenOf(100, proc), [{ pid: 101, start: "101" }]);
    assert.equal(await isRunuser(100, proc), true);
    assert.equal(await isRunuser(101, proc), false);
    assert.equal(await isRunuser(12345, proc), false);
  });
});

describe("terminateGroup", () => {
  it("signals the mind's processes and spares the runuser supervisor (#1364)", async () => {
    // runuser SIGKILLs its child 2s after it is itself SIGTERMed, so a stop must
    // never signal it — nor the group, which would include it.
    const { sent, kill } = recorder();
    const r = await terminateGroup(100, { spareLeader: true, procDir: fakeProc(mindTree()), kill });
    assert.equal(r, "signalled");
    assert.deepEqual(sent.sort(byPid), [
      [101, "SIGTERM"],
      [102, "SIGTERM"],
      [301, "SIGTERM"],
    ]);
  });

  it("skips a pid that was reused since the scan", async () => {
    const proc = fakeProc(mindTree());
    const sent: number[] = [];
    const kill = (pid: number) => {
      sent.push(pid);
      // After the first signal, every other member's pid is taken by a new process.
      for (const other of [101, 102, 301].filter((p) => p !== pid)) {
        writeStat(proc, other, { comm: "new", pgrp: 100, start: 999 });
      }
    };
    await terminateGroup(100, { spareLeader: true, procDir: proc, kill });
    assert.equal(sent.length, 1);
  });

  it("signals the whole group when nothing is supervising", async () => {
    const { sent, kill } = recorder();
    await terminateGroup(100, { spareLeader: false, procDir: fakeProc(mindTree()), kill });
    assert.deepEqual(sent, [[-100, "SIGTERM"]]);
  });

  it("falls back to the group when only the supervisor is left", async () => {
    const { sent, kill } = recorder();
    const proc = fakeProc({ 100: { comm: "runuser", pgrp: 100 } });
    await terminateGroup(100, { spareLeader: true, procDir: proc, kill });
    assert.deepEqual(sent, [[-100, "SIGTERM"]]);
  });

  it("falls back to the group, and says so, when /proc can't be scanned", async () => {
    const logs = captureLogs();
    try {
      const { sent, kill } = recorder();
      await terminateGroup(100, { spareLeader: true, procDir: "/nonexistent-proc", kill });
      assert.deepEqual(sent, [[-100, "SIGTERM"]]);
      assert.ok(logs.lines.some((l) => l.includes("could not scan process group 100")));
    } finally {
      logs.restore();
    }
  });

  it("sends nothing for a reaped leader whose group has no members left", async () => {
    // Nothing holds the id any more, so a group signal could reach a new group.
    const { sent, kill } = recorder();
    const proc = fakeProc({ 400: { comm: "unrelated", pgrp: 999 } });
    for (const spareLeader of [true, false]) {
      const r = await terminateGroup(100, { spareLeader, leaderExited: true, procDir: proc, kill });
      assert.equal(r, "gone");
    }
    assert.deepEqual(sent, []);
  });

  it("signals the group of a reaped leader while a member still holds it", async () => {
    const { sent, kill } = recorder();
    const proc = fakeProc({ 301: { comm: "worker", pgrp: 100 } });
    await terminateGroup(100, { spareLeader: false, leaderExited: true, procDir: proc, kill });
    assert.deepEqual(sent, [[-100, "SIGTERM"]]);
  });

  it("reports a group that is already gone", async () => {
    const { kill } = recorder(() => errno("ESRCH"));
    const procDir = fakeProc({});
    assert.equal(await terminateGroup(100, { spareLeader: false, procDir, kill }), "gone");
  });

  it("logs a failure other than ESRCH and keeps signalling the rest", async () => {
    const logs = captureLogs();
    try {
      const { sent, kill } = recorder((pid) => (pid === 101 ? errno("EPERM") : undefined));
      await terminateGroup(100, { spareLeader: true, procDir: fakeProc(mindTree()), kill });
      assert.deepEqual(sent.sort(byPid), [
        [102, "SIGTERM"],
        [301, "SIGTERM"],
      ]);
      assert.ok(logs.lines.some((l) => l.includes("SIGTERM to pid 101 failed")));
    } finally {
      logs.restore();
    }
  });
});

describe("stopGroup", () => {
  it("sends no SIGKILL on a clean exit, and at the deadline kills the group only if it has members", async () => {
    const proc = fakeProc(mindTree());
    const child = fakeChild(100);
    const { sent, kill } = recorder();
    const stopped = stopGroup(child, { spareLeader: true, graceMs: 150, procDir: proc, kill });
    await delay(10);
    // runuser and node exit; the SDK subprocess (102) is still flushing.
    for (const pid of [100, 101, 301]) rmSync(resolve(proc, String(pid)), { recursive: true });
    child.emit("exit", 0);
    const exitedAt = Date.now();
    await stopped;
    assert.ok(Date.now() - exitedAt < 100, "a clean exit does not wait out the grace");
    assert.ok(!sent.some(([, sig]) => sig === "SIGKILL"), "nothing SIGKILLed on exit");
    await delay(250);
    // 102 still holds the group's id, which makes the group signal safe.
    assert.deepEqual(
      sent.filter(([, sig]) => sig === "SIGKILL"),
      [[-100, "SIGKILL"]],
    );
  });

  it("sends nothing at the deadline when the whole group has gone", async () => {
    const proc = fakeProc(mindTree());
    const child = fakeChild(100);
    const { sent, kill } = recorder();
    const stopped = stopGroup(child, { spareLeader: true, graceMs: 50, procDir: proc, kill });
    await delay(10);
    for (const pid of [100, 101, 102, 301]) rmSync(resolve(proc, String(pid)), { recursive: true });
    child.emit("exit", 0);
    await stopped;
    await delay(120);
    assert.ok(!sent.some(([, sig]) => sig === "SIGKILL"));
  });

  it("SIGKILLs the group at the deadline while its leader is still alive", async () => {
    const { sent, kill } = recorder();
    await stopGroup(fakeChild(100), {
      spareLeader: false,
      graceMs: 30,
      procDir: fakeProc({ 100: { comm: "node", pgrp: 100 } }),
      kill,
    });
    assert.deepEqual(sent, [
      [-100, "SIGTERM"],
      [-100, "SIGKILL"],
    ]);
  });

  it("keeps the deadline when the SIGTERM fails, and logs it", async () => {
    const logs = captureLogs();
    try {
      const { sent, kill } = recorder((_pid, sig) =>
        sig === "SIGTERM" ? errno("EPERM") : undefined,
      );
      // The leader is still alive in /proc, so the deadline's scan finds the group.
      const procDir = fakeProc({ 100: { comm: "node", pgrp: 100 } });
      await stopGroup(fakeChild(100), { spareLeader: false, graceMs: 30, procDir, kill });
      assert.deepEqual(sent, [[-100, "SIGKILL"]]);
      assert.ok(logs.lines.some((l) => l.includes("SIGTERM to process group 100 failed")));
    } finally {
      logs.restore();
    }
  });

  it("sends nothing more to a group that is already gone", async () => {
    const { sent, kill } = recorder((_pid, sig) =>
      sig === "SIGTERM" ? errno("ESRCH") : undefined,
    );
    await stopGroup(fakeChild(100), {
      spareLeader: false,
      graceMs: 60_000,
      procDir: fakeProc({}),
      kill,
    });
    assert.deepEqual(sent, []);
  });

  it("waits for an orphan leader it didn't spawn to exit, bounded", async () => {
    const proc = fakeProc({ 100: { comm: "node", pgrp: 100 } });
    const { sent, kill } = recorder();
    let returned = false;
    const stopped = stopGroup(100, { spareLeader: false, graceMs: 5_000, procDir: proc, kill });
    void stopped.then(() => (returned = true));
    await delay(300);
    assert.equal(returned, false, "still waiting while the orphan runs");
    rmSync(resolve(proc, "100"), { recursive: true });
    const exitedAt = Date.now();
    await stopped;
    assert.ok(Date.now() - exitedAt < 1_000, "returns once the orphan is gone");
    assert.deepEqual(sent, [[-100, "SIGTERM"]]);
  });
});

describe("exec's registration", () => {
  it("records a pre-wrapped command as supervised when the caller says so", async () => {
    const running = exec("sleep", ["5"], { supervised: true });
    running.catch(() => {});
    assert.ok(trackedChildren().some((h) => !h.group && h.supervised));
    await stopTrackedChildren(2_000);
    await assert.rejects(running);
  });
  it("leaves a child out of the shutdown set when asked (the stop sweep's reads)", async () => {
    const before = trackedChildren().length;
    const untimed = exec("sleep", ["0.3"], { track: false });
    const timed = exec("sleep", ["0.3"], { track: false, timeout: 5_000 });
    assert.equal(trackedChildren().length, before);
    await Promise.all([untimed, timed]);
  });
});

describe("stopTrackedChildren", () => {
  /** A real `sh` that records the SIGTERM it gets, once it is up. */
  async function trapping(dir: string, name: string, timed: boolean) {
    const script = `trap 'echo term >> "${dir}/${name}"; exit 0' TERM; touch "${dir}/${name}-up"; sleep 30 & wait`;
    let child: ChildProcess | null = null;
    const done = timed
      ? exec("sh", ["-c", script], { timeout: 60_000 })
      : new Promise<void>((resolve) => {
          child = spawn("sh", ["-c", script], { stdio: "ignore" });
          child.on("exit", () => resolve());
        });
    done.catch(() => {});
    while (!existsSync(resolve(dir, `${name}-up`))) await delay(10);
    return { done, child: child as ChildProcess | null };
  }

  it("SIGTERMs an in-flight timed child at daemon shutdown and waits for it", async () => {
    const dir = tempDir("exec-shutdown-");
    const { done } = await trapping(dir, "timed", true);
    const started = Date.now();
    await stopTrackedChildren(5_000);
    assert.ok(existsSync(resolve(dir, "timed")), "the script ran its SIGTERM handler");
    assert.ok(
      Date.now() - started < 4_000,
      "a script that exits on SIGTERM isn't held to the grace",
    );
    await done;
  });

  it("also stops a child registered while the shutdown is under way", async () => {
    const dir = tempDir("exec-shutdown-");
    const first = await trapping(dir, "first", true);
    let shutdownDone!: () => void;
    const rest = new Promise<void>((r) => (shutdownDone = r));
    const stopping = stopTrackedChildren(5_000, rest);
    const late = await trapping(dir, "late", false);
    trackChild(late.child!, { group: false, supervised: false });
    shutdownDone();
    await stopping;
    await Promise.all([first.done, late.done]);
    assert.ok(existsSync(resolve(dir, "first")));
    assert.equal(readFileSync(resolve(dir, "late"), "utf-8").trim(), "term");
  });

  it("signals an untimed supervised child's own children, not the supervisor", async () => {
    const dir = tempDir("exec-shutdown-");
    const { child, done } = await trapping(dir, "sup", false);
    await delay(50); // let sh fork the sleep
    trackChild(child!, { group: false, supervised: true });
    await stopTrackedChildren(5_000);
    await done;
    if (process.platform === "linux") {
      // The sleep below took the SIGTERM; sh — standing in for runuser — did not.
      assert.equal(existsSync(resolve(dir, "sup")), false);
    } else {
      // No /proc: the child itself is signalled, as runuser would relay it.
      assert.ok(existsSync(resolve(dir, "sup")));
    }
  });
});
