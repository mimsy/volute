import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, describe, it } from "node:test";
import { exec, stopExecChildren } from "../packages/daemon/src/lib/util/exec.js";
import log from "../packages/daemon/src/lib/util/logger.js";
import {
  groupDescendants,
  stopGroup,
  terminateGroup,
} from "../packages/daemon/src/lib/util/process-group.js";

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
    const pid = Number(key);
    const task = resolve(dir, key, "task", key);
    mkdirSync(task, { recursive: true });
    writeStat(dir, pid, p);
    writeFileSync(resolve(task, "stat"), "");
    writeFileSync(resolve(task, "children"), (p.children ?? []).map((c) => `${c} `).join(""));
  }
  return dir;
}

/** The usual isolated mind: runuser leads, node below it, the SDK below node. */
const mindTree = (): Record<number, FakeProc> => ({
  100: { comm: "runuser", pgrp: 100, children: [101] },
  101: { comm: "node", pgrp: 100, children: [102, 300] },
  // comm can hold spaces and parens; fields are counted from the last ')'
  102: { comm: "claude (sdk) 7 9", pgrp: 100 },
  // setsid'd away: walked through, but not in the group
  300: { comm: "detached", pgrp: 300, children: [301] },
  301: { comm: "grandchild", pgrp: 100 },
  // in the group but not below the leader — not reachable by the walk
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

describe("groupDescendants", () => {
  it("walks the leader's descendants and keeps those in its group", async () => {
    const proc = fakeProc(mindTree());
    const members = await groupDescendants(100, [100], { procDir: proc, exclude: 100 });
    assert.deepEqual(
      members.map((m) => m.pid).sort((a, b) => a - b),
      [101, 102, 301],
    );
    assert.equal(members.find((m) => m.pid === 101)?.start, "101");
  });

  it("refuses to read a missing children file as 'no children'", async () => {
    const proc = fakeProc({ 100: { comm: "runuser", pgrp: 100, children: [101] } });
    rmSync(resolve(proc, "100", "task", "100", "children"));
    await assert.rejects(groupDescendants(100, [100], { procDir: proc }), /CONFIG_PROC_CHILDREN/);
  });
});

describe("terminateGroup", () => {
  it("signals the mind's processes and spares the runuser supervisor (#1364)", async () => {
    // runuser SIGKILLs its child 2s after it is itself SIGTERMed, so a stop must
    // never signal it — nor the group, which would include it.
    const proc = fakeProc(mindTree());
    const { sent, kill } = recorder();
    const r = await terminateGroup(100, { spareLeader: true, procDir: proc, kill });
    assert.equal(r.gone, false);
    assert.deepEqual(sent.sort(byPid), [
      [101, "SIGTERM"],
      [102, "SIGTERM"],
      [301, "SIGTERM"],
    ]);
  });

  it("skips a pid that was reused since the walk", async () => {
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
    const proc = fakeProc({ 100: { comm: "runuser", pgrp: 100 } });
    const { sent, kill } = recorder();
    await terminateGroup(100, { spareLeader: true, procDir: proc, kill });
    assert.deepEqual(sent, [[-100, "SIGTERM"]]);
  });

  it("falls back to the group, and says so, when /proc can't be walked", async () => {
    const logs = captureLogs();
    try {
      const { sent, kill } = recorder();
      await terminateGroup(100, { spareLeader: true, procDir: "/nonexistent-proc", kill });
      assert.deepEqual(sent, [[-100, "SIGTERM"]]);
      assert.ok(logs.lines.some((l) => l.includes("could not walk process group 100")));
    } finally {
      logs.restore();
    }
  });

  it("reports a group that is already gone", async () => {
    const { kill } = recorder(() => errno("ESRCH"));
    assert.equal((await terminateGroup(100, { spareLeader: false, kill })).gone, true);
  });

  it("logs a failure other than ESRCH and keeps signalling the rest", async () => {
    const logs = captureLogs();
    try {
      const proc = fakeProc(mindTree());
      const { sent, kill } = recorder((pid) => (pid === 101 ? errno("EPERM") : undefined));
      await terminateGroup(100, { spareLeader: true, procDir: proc, kill });
      assert.deepEqual(sent.sort(byPid), [
        [102, "SIGTERM"],
        [301, "SIGTERM"],
      ]);
      assert.ok(logs.lines.some((l) => l.includes("SIGTERM to pid 101 (group 100) failed")));
      assert.ok(!logs.lines.some((l) => l.includes("pid 102")), "ESRCH would be silent");
    } finally {
      logs.restore();
    }
  });
});

describe("stopGroup", () => {
  it("sends no SIGKILL on a clean exit, and at the deadline kills only survivors", async () => {
    const proc = fakeProc(mindTree());
    const child = fakeChild(100);
    const { sent, kill } = recorder();
    const stopped = stopGroup(child, { spareLeader: true, graceMs: 150, procDir: proc, kill });
    await delay(10);
    // node and runuser exit; the SDK subprocess (102) is still flushing.
    rmSync(resolve(proc, "101"), { recursive: true });
    child.emit("exit", 0);
    const exitedAt = Date.now();
    await stopped;
    assert.ok(Date.now() - exitedAt < 100, "a clean exit does not wait out the grace");
    assert.ok(!sent.some(([, sig]) => sig === "SIGKILL"), "nothing SIGKILLed on exit");
    await delay(250);
    // The straggler that outlived the deadline, individually — never the group.
    assert.deepEqual(sent.filter(([, sig]) => sig === "SIGKILL").sort(byPid), [
      [102, "SIGKILL"],
      [301, "SIGKILL"],
    ]);
  });

  it("sends nothing at the deadline when everything has gone", async () => {
    const proc = fakeProc(mindTree());
    const child = fakeChild(100);
    const { sent, kill } = recorder();
    const stopped = stopGroup(child, { spareLeader: true, graceMs: 50, procDir: proc, kill });
    await delay(10);
    for (const pid of [101, 102, 301]) rmSync(resolve(proc, String(pid)), { recursive: true });
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
      await stopGroup(fakeChild(100), { spareLeader: false, graceMs: 30, kill });
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
    await stopGroup(fakeChild(100), { spareLeader: false, graceMs: 60_000, kill });
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

describe("stopExecChildren", () => {
  it("SIGTERMs an in-flight timed child at daemon shutdown and waits for it", async () => {
    const dir = tempDir("exec-shutdown-");
    const marker = resolve(dir, "got-term");
    const running = exec(
      "sh",
      ["-c", `trap 'echo term > "${marker}"; exit 0' TERM; touch "${dir}/up"; sleep 30 & wait`],
      { timeout: 60_000 },
    );
    running.catch(() => {});
    while (!existsSync(resolve(dir, "up"))) await delay(10);
    const started = Date.now();
    await stopExecChildren(5_000);
    assert.ok(existsSync(marker), "the script ran its SIGTERM handler");
    assert.ok(
      Date.now() - started < 4_000,
      "a script that exits on SIGTERM isn't held to the grace",
    );
    await running;
  });
});
