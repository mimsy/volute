import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, describe, it } from "node:test";
import log from "../packages/daemon/src/lib/util/logger.js";
import {
  groupMembersExcept,
  stopGroup,
  terminateGroup,
} from "../packages/daemon/src/lib/util/process-group.js";

const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function statLine(pid: number, comm: string, pgrp: number, start: number): string {
  // state ppid pgrp session tty tpgid flags, 12 counters, then starttime (field 22)
  return `${pid} (${comm}) S 1 ${pgrp} ${pgrp} 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 ${start} 0 0\n`;
}

/** A fake /proc: each entry is `pid → [comm, pgrp]`; a process's start time is its pid. */
function fakeProc(procs: Record<number, [string, number]>): string {
  const dir = mkdtempSync(resolve(tmpdir(), "fake-proc-"));
  tempDirs.push(dir);
  for (const [pid, [comm, pgrp]] of Object.entries(procs)) {
    mkdirSync(resolve(dir, pid));
    writeFileSync(resolve(dir, pid, "stat"), statLine(Number(pid), comm, pgrp, Number(pid)));
  }
  mkdirSync(resolve(dir, "self"));
  mkdirSync(resolve(dir, "77")); // a pid that exited mid-scan: no stat
  return dir;
}

function recorder(fail?: (pid: number, sig: string) => Error | undefined) {
  const sent: [number, string][] = [];
  const kill = (pid: number, sig: string) => {
    const err = fail?.(pid, sig);
    if (err) throw err;
    sent.push([pid, sig]);
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

describe("groupMembersExcept", () => {
  it("lists the group's members other than the excluded pid, with start times", async () => {
    const proc = fakeProc({
      100: ["runuser", 100],
      101: ["node", 100],
      // comm can hold spaces and parens; fields are counted from the last ')'
      102: ["claude (sdk) 7 9", 100],
      200: ["node", 200],
    });
    const members = await groupMembersExcept(100, 100, proc);
    assert.deepEqual(
      members.sort((a, b) => a.pid - b.pid),
      [
        { pid: 101, start: "101" },
        { pid: 102, start: "102" },
      ],
    );
  });
});

describe("terminateGroup", () => {
  it("signals the mind's processes and spares the runuser supervisor (#1364)", async () => {
    // runuser SIGKILLs its child 2s after it is itself SIGTERMed, so a stop must
    // never signal it — nor the group, which would include it.
    const proc = fakeProc({ 100: ["runuser", 100], 101: ["node", 100], 102: ["claude", 100] });
    const { sent, kill } = recorder();
    assert.equal(
      await terminateGroup(100, { spareLeader: true, procDir: proc, kill }),
      "signalled",
    );
    assert.deepEqual(sent.sort(byPid), [
      [101, "SIGTERM"],
      [102, "SIGTERM"],
    ]);
  });

  it("skips a pid that was reused since the scan", async () => {
    const proc = fakeProc({ 100: ["runuser", 100], 101: ["node", 100], 102: ["claude", 100] });
    const sent: number[] = [];
    const kill = (pid: number) => {
      sent.push(pid);
      // After the first signal, the other member's pid is taken by a new process.
      const other = pid === 101 ? 102 : 101;
      writeFileSync(resolve(proc, String(other), "stat"), statLine(other, "new", 100, 999));
    };
    await terminateGroup(100, { spareLeader: true, procDir: proc, kill });
    assert.equal(sent.length, 1);
  });

  it("signals the whole group when nothing is supervising", async () => {
    const proc = fakeProc({ 100: ["node", 100], 101: ["claude", 100] });
    const { sent, kill } = recorder();
    await terminateGroup(100, { spareLeader: false, procDir: proc, kill });
    assert.deepEqual(sent, [[-100, "SIGTERM"]]);
  });

  it("falls back to the group when only the supervisor is left", async () => {
    const proc = fakeProc({ 100: ["runuser", 100] });
    const { sent, kill } = recorder();
    await terminateGroup(100, { spareLeader: true, procDir: proc, kill });
    assert.deepEqual(sent, [[-100, "SIGTERM"]]);
  });

  it("falls back to the group, and says so, when /proc can't be read", async () => {
    const logs = captureLogs();
    try {
      const { sent, kill } = recorder();
      await terminateGroup(100, { spareLeader: true, procDir: "/nonexistent-proc", kill });
      assert.deepEqual(sent, [[-100, "SIGTERM"]]);
      assert.ok(logs.lines.some((l) => l.includes("could not list process group 100")));
    } finally {
      logs.restore();
    }
  });

  it("reports a group that is already gone", async () => {
    const { kill } = recorder(() => errno("ESRCH"));
    assert.equal(await terminateGroup(100, { spareLeader: false, kill }), "gone");
  });

  it("throws a failure other than ESRCH, after signalling every member it can", async () => {
    const proc = fakeProc({ 100: ["runuser", 100], 101: ["node", 100], 102: ["claude", 100] });
    const perm = recorder((pid) => (pid === 101 ? errno("EPERM") : undefined));
    await assert.rejects(
      terminateGroup(100, { spareLeader: true, procDir: proc, kill: perm.kill }),
      /EPERM/,
    );
    assert.deepEqual(perm.sent, [[102, "SIGTERM"]]);
    const gone = recorder((pid) => (pid === 101 ? errno("ESRCH") : undefined));
    await terminateGroup(100, { spareLeader: true, procDir: proc, kill: gone.kill });
    assert.deepEqual(gone.sent, [[102, "SIGTERM"]]);
  });
});

describe("stopGroup", () => {
  const fakeChild = (pid: number) => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    Object.assign(child, { pid, exitCode: null, signalCode: null });
    return child;
  };

  it("SIGKILLs what is left of the group the moment the leader exits, and only then", async () => {
    const proc = fakeProc({ 100: ["runuser", 100], 101: ["node", 100] });
    const child = fakeChild(100);
    const { sent, kill } = recorder();
    const stopped = stopGroup(child, { spareLeader: true, graceMs: 200, procDir: proc, kill });
    await new Promise((r) => setTimeout(r, 10));
    const exitedAt = Date.now();
    child.emit("exit", 0);
    await stopped;
    assert.ok(Date.now() - exitedAt < 100, "a clean exit does not wait out the grace");
    // Past the deadline: the disarmed timer must not send a second, late SIGKILL.
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(sent, [
      [101, "SIGTERM"],
      [-100, "SIGKILL"],
    ]);
  });

  it("SIGKILLs the group at the deadline when the leader doesn't exit", async () => {
    const proc = fakeProc({ 100: ["node", 100] });
    const { sent, kill } = recorder();
    await stopGroup(fakeChild(100), { spareLeader: false, graceMs: 30, procDir: proc, kill });
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
});
