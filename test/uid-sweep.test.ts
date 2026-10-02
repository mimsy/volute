import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, describe, it } from "node:test";
import { sweepUid } from "../packages/daemon/src/lib/util/uid-sweep.js";

const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const DAEMON = 50;
const MIND_UID = 1234;

type FakeProc = { ppid: number; pgrp: number; uid: number; start?: number };

function writeProc(dir: string, pid: number, p: FakeProc): void {
  mkdirSync(resolve(dir, String(pid)), { recursive: true });
  // state ppid pgrp session tty tpgid flags, 12 counters, then starttime (field 22)
  writeFileSync(
    resolve(dir, String(pid), "stat"),
    `${pid} (p ${pid}) S ${p.ppid} ${p.pgrp} ${p.pgrp} 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 ${p.start ?? pid} 0 0\n`,
  );
  writeFileSync(
    resolve(dir, String(pid), "status"),
    `Name:\tp\nPPid:\t${p.ppid}\nUid:\t${p.uid}\t${p.uid}\t${p.uid}\t${p.uid}\n`,
  );
}

function fakeProc(procs: Record<number, FakeProc>): string {
  const dir = mkdtempSync(resolve(tmpdir(), "fake-proc-sweep-"));
  tempDirs.push(dir);
  for (const [pid, p] of Object.entries(procs)) writeProc(dir, Number(pid), p);
  mkdirSync(resolve(dir, "self"));
  mkdirSync(resolve(dir, "77")); // exited mid-scan: no stat
  return dir;
}

/** A stopped mind's leftovers, beside the things a sweep must never touch. */
const world = (): Record<number, FakeProc> => ({
  1: { ppid: 0, pgrp: 1, uid: 0 },
  [DAEMON]: { ppid: 1, pgrp: DAEMON, uid: 0 },
  // a `setsid nohup sleep &` from the Claude CLI, reparented to init
  300: { ppid: 1, pgrp: 300, uid: MIND_UID },
  301: { ppid: 300, pgrp: 300, uid: MIND_UID },
  // a scheduled script the daemon is running as the mind: runuser → sh → its child
  400: { ppid: DAEMON, pgrp: 400, uid: 0 },
  401: { ppid: 400, pgrp: 400, uid: MIND_UID },
  402: { ppid: 401, pgrp: 400, uid: MIND_UID },
  // a straggler of the stopped mind's own group, which its stop's deadline covers
  500: { ppid: 1, pgrp: 500, uid: MIND_UID },
  // another mind's
  600: { ppid: 1, pgrp: 600, uid: 4321 },
});

function recorder(onKill?: (pid: number, sig: string) => void) {
  const sent: [number, string][] = [];
  const kill = (pid: number, sig: string | 0) => {
    if (sig === 0) return;
    sent.push([pid, sig]);
    onKill?.(pid, sig);
  };
  return { sent, kill };
}

const opts = (procDir: string, kill: ReturnType<typeof recorder>["kill"]) => ({
  procDir,
  kill,
  ancestor: DAEMON,
  spareGroup: 500,
  boundMs: 300,
});

describe("sweepUid", () => {
  it("SIGTERMs the uid's strays, and nothing the daemon runs, the stopped group or another uid", async () => {
    const procDir = fakeProc(world());
    // The strays exit on SIGTERM.
    const { sent, kill } = recorder((pid) =>
      rmSync(resolve(procDir, String(pid)), { recursive: true }),
    );
    const swept = await sweepUid(MIND_UID, opts(procDir, kill));
    assert.equal(swept, 2);
    assert.deepEqual(
      sent.sort((a, b) => a[0] - b[0]),
      [
        [300, "SIGTERM"],
        [301, "SIGTERM"],
      ],
    );
  });

  it("SIGKILLs what is still there at the bound", async () => {
    const procDir = fakeProc(world());
    const { sent, kill } = recorder();
    await sweepUid(MIND_UID, opts(procDir, kill));
    assert.deepEqual(
      sent
        .filter(([, s]) => s === "SIGKILL")
        .map(([p]) => p)
        .sort(),
      [300, 301],
    );
  });

  it("does not signal a pid that became another process between the scan and the signal", async () => {
    const procDir = fakeProc({
      300: { ppid: 1, pgrp: 300, uid: MIND_UID },
      301: { ppid: 1, pgrp: 301, uid: MIND_UID },
    });
    // The first signal lands; before the second, the other pid is reused.
    const { sent, kill } = recorder((pid) => {
      const other = pid === 300 ? 301 : 300;
      writeProc(procDir, other, { ppid: 1, pgrp: other, uid: MIND_UID, start: 99999 });
      rmSync(resolve(procDir, String(pid)), { recursive: true });
    });
    await sweepUid(MIND_UID, { ...opts(procDir, kill), boundMs: 0 });
    assert.equal(sent.filter(([, s]) => s === "SIGTERM").length, 1);
  });

  it("does not signal a pid now held by another uid", async () => {
    const procDir = fakeProc({
      300: { ppid: 1, pgrp: 300, uid: MIND_UID },
      301: { ppid: 1, pgrp: 301, uid: MIND_UID },
    });
    const { sent, kill } = recorder((pid) => {
      const other = pid === 300 ? 301 : 300;
      writeProc(procDir, other, { ppid: 1, pgrp: other, uid: 0, start: other });
    });
    await sweepUid(MIND_UID, { ...opts(procDir, kill), boundMs: 0 });
    assert.equal(sent.filter(([, s]) => s === "SIGTERM").length, 1);
  });

  it("is called off by `proceed`, before the SIGTERM or before the SIGKILL", async () => {
    const procDir = fakeProc(world());
    const none = recorder();
    assert.equal(
      await sweepUid(MIND_UID, { ...opts(procDir, none.kill), proceed: () => false }),
      0,
    );
    assert.deepEqual(none.sent, []);

    let calls = 0;
    const termOnly = recorder();
    await sweepUid(MIND_UID, { ...opts(procDir, termOnly.kill), proceed: () => calls++ === 0 });
    assert.ok(termOnly.sent.length > 0);
    assert.ok(termOnly.sent.every(([, s]) => s === "SIGTERM"));
  });

  it("refuses root and the daemon's own uid", async () => {
    const procDir = fakeProc({ 300: { ppid: 1, pgrp: 300, uid: 0 } });
    const { sent, kill } = recorder();
    assert.equal(await sweepUid(0, opts(procDir, kill)), 0);
    if (process.getuid) {
      writeProc(procDir, 301, { ppid: 1, pgrp: 301, uid: process.getuid() });
      assert.equal(await sweepUid(process.getuid(), opts(procDir, kill)), 0);
    }
    assert.deepEqual(sent, []);
  });

  it("survives a ppid cycle", async () => {
    const procDir = fakeProc({
      300: { ppid: 301, pgrp: 300, uid: MIND_UID },
      301: { ppid: 300, pgrp: 300, uid: MIND_UID },
    });
    const { sent, kill } = recorder((pid) =>
      rmSync(resolve(procDir, String(pid)), { recursive: true }),
    );
    assert.equal(await sweepUid(MIND_UID, opts(procDir, kill)), 2);
    assert.equal(sent.length, 2);
  });
});
