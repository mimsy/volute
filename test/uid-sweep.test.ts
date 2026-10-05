import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, describe, it } from "node:test";
import { promisify } from "node:util";
import log from "../packages/daemon/src/lib/util/logger.js";
import { ownerMarkReader, sweepMindProcesses } from "../packages/daemon/src/lib/util/uid-sweep.js";

const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const DAEMON = 50;
const MIND_UID = 1234;
const MIND = "alice";
const OURS = `VOLUTE_MIND=${MIND}`;

type FakeProc = { ppid: number; pgrp: number; uid: number; env?: string[]; start?: number };

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
  writeFileSync(resolve(dir, String(pid), "environ"), (p.env ?? []).map((e) => `${e}\0`).join(""));
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
  // a `setsid nohup sleep &` from the Claude CLI, reparented to init, and its child
  300: { ppid: 1, pgrp: 300, uid: MIND_UID, env: ["PATH=/bin", OURS, "HOME=/m"] },
  301: { ppid: 300, pgrp: 300, uid: MIND_UID, env: [OURS] },
  // a scheduled script the daemon is running as the mind: runuser → sh → its child
  400: { ppid: DAEMON, pgrp: 400, uid: 0, env: [OURS] },
  401: { ppid: 400, pgrp: 400, uid: MIND_UID, env: [OURS] },
  402: { ppid: 401, pgrp: 400, uid: MIND_UID, env: [OURS] },
  // a host's `sudo -u mind-alice bash`: the uid, not the marker
  500: { ppid: 1, pgrp: 500, uid: MIND_UID, env: ["USER=mind-alice"] },
  // a variant's background job: the uid, its own name
  501: { ppid: 1, pgrp: 501, uid: MIND_UID, env: [`VOLUTE_MIND=${MIND}-v`, `X=${OURS}`] },
  // another mind's
  600: { ppid: 1, pgrp: 600, uid: 4321, env: [OURS] },
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

const opts = (procDir: string, kill: ReturnType<typeof recorder>["kill"], graceMs = 300) => ({
  procDir,
  kill,
  ancestor: DAEMON,
  killAt: Date.now() + graceMs,
});

const sorted = (sent: [number, string][], sig: string) =>
  sent
    .filter(([, s]) => s === sig)
    .map(([p]) => p)
    .sort();

describe("sweepMindProcesses", () => {
  it("SIGTERMs the mind's own strays, and nothing the daemon runs, a host's shell, a variant's or another uid's", async () => {
    const procDir = fakeProc(world());
    // The strays exit on SIGTERM.
    const { sent, kill } = recorder((pid) =>
      rmSync(resolve(procDir, String(pid)), { recursive: true }),
    );
    assert.equal(await sweepMindProcesses(MIND_UID, MIND, opts(procDir, kill)), 2);
    assert.deepEqual(sorted(sent, "SIGTERM"), [300, 301]);
    assert.deepEqual(sorted(sent, "SIGKILL"), []);
  });

  it("SIGKILLs what is still there at the bound, and only what it SIGTERMed", async () => {
    const procDir = fakeProc(world());
    // A job forked after the scan is not the one it watched.
    const { sent, kill } = recorder((pid, sig) => {
      if (sig === "SIGTERM" && pid === 300) {
        writeProc(procDir, 302, { ppid: 1, pgrp: 302, uid: MIND_UID, env: [OURS] });
      }
    });
    await sweepMindProcesses(MIND_UID, MIND, opts(procDir, kill));
    assert.deepEqual(sorted(sent, "SIGKILL"), [300, 301]);
  });

  it("does not signal a pid that became another process between the scan and the signal", async () => {
    const procDir = fakeProc({
      300: { ppid: 1, pgrp: 300, uid: MIND_UID, env: [OURS] },
      301: { ppid: 1, pgrp: 301, uid: MIND_UID, env: [OURS] },
    });
    // The first signal lands; before the second, the other pid is reused.
    const { sent, kill } = recorder((pid) => {
      const other = pid === 300 ? 301 : 300;
      writeProc(procDir, other, {
        ppid: 1,
        pgrp: other,
        uid: MIND_UID,
        env: [OURS],
        start: 99999,
      });
      rmSync(resolve(procDir, String(pid)), { recursive: true });
    });
    await sweepMindProcesses(MIND_UID, MIND, opts(procDir, kill, 0));
    assert.equal(sent.length, 1);
  });

  for (const [what, changed] of [["another uid", { uid: 0, env: [OURS] }]] as const) {
    it(`does not signal a process that has ${what} by the time it is signalled`, async () => {
      const procDir = fakeProc({
        300: { ppid: 1, pgrp: 300, uid: MIND_UID, env: [OURS] },
        301: { ppid: 1, pgrp: 301, uid: MIND_UID, env: [OURS] },
      });
      const { sent, kill } = recorder((pid) => {
        const other = pid === 300 ? 301 : 300;
        writeProc(procDir, other, {
          ppid: 1,
          pgrp: other,
          start: other,
          ...changed,
          env: [...changed.env],
        });
      });
      await sweepMindProcesses(MIND_UID, MIND, opts(procDir, kill, 0));
      assert.equal(sent.filter(([, s]) => s === "SIGTERM").length, 1);
    });
  }

  it("reads an environ it may not read directly as the process's owner", {
    skip: process.getuid?.() === 0 && "root reads past the file mode",
  }, async () => {
    const procDir = fakeProc({
      300: { ppid: 1, pgrp: 300, uid: MIND_UID, env: [OURS] },
      301: { ppid: 1, pgrp: 301, uid: MIND_UID, env: [OURS] },
      302: { ppid: 1, pgrp: 302, uid: MIND_UID, env: ["USER=mind-alice"] },
    });
    for (const pid of [300, 301, 302]) chmodSync(resolve(procDir, String(pid), "environ"), 0);
    const direct = recorder();
    assert.equal(await sweepMindProcesses(MIND_UID, MIND, opts(procDir, direct.kill, 0)), 0);
    // One read as the owner, for every refused environ, answering which hold the marker.
    const calls: [string[], string][] = [];
    const markedAsOwner = async (paths: string[], entry: string) => {
      calls.push([paths, entry]);
      return paths.filter((p) => !p.includes("/302/"));
    };
    const viaOwner = recorder();
    assert.equal(
      await sweepMindProcesses(MIND_UID, MIND, {
        ...opts(procDir, viaOwner.kill, 0),
        markedAsOwner,
      }),
      2,
    );
    assert.deepEqual(sorted(viaOwner.sent, "SIGTERM"), [300, 301]);
    assert.equal(calls.length, 1);
    assert.deepEqual(
      calls[0][0].sort(),
      [300, 301, 302].map((p) => `${procDir}/${p}/environ`),
    );
    assert.equal(calls[0][1], OURS);
  });

  it("the owner-read finds every marked environ, whatever the last one holds", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "owner-read-"));
    tempDirs.push(dir);
    const files = {
      marked: ["PATH=/bin", OURS],
      variant: [`${OURS}-v`],
      prefixed: [`X${OURS}`],
      unmarked: ["USER=mind-alice"],
    };
    const paths = Object.entries(files).map(([f, env]) => {
      writeFileSync(resolve(dir, f), `${env.join("\0")}\0`);
      return resolve(dir, f);
    });
    // The real script, run here as ourselves rather than wrapped as a mind's user.
    const run = async (cmd: string, args: string[]) =>
      (await promisify(execFile)(cmd, args)).stdout;
    const read = ownerMarkReader(run);
    assert.deepEqual(await read([...paths, resolve(dir, "missing")], OURS), [paths[0]]);
  });

  it("a failed owner-read still sweeps what root could read", {
    skip: process.getuid?.() === 0 && "root reads past the file mode",
  }, async () => {
    const procDir = fakeProc({
      300: { ppid: 1, pgrp: 300, uid: MIND_UID, env: [OURS] },
      301: { ppid: 1, pgrp: 301, uid: MIND_UID, env: [OURS] },
    });
    chmodSync(resolve(procDir, "301", "environ"), 0);
    const r = recorder();
    const markedAsOwner = async () => {
      throw new Error("runuser failed");
    };
    assert.equal(
      await sweepMindProcesses(MIND_UID, MIND, { ...opts(procDir, r.kill, 0), markedAsOwner }),
      1,
    );
    assert.deepEqual(sorted(r.sent, "SIGTERM"), [300]);
  });

  it("waits for the SIGKILL until `killAt`, not a bound of its own", async () => {
    const procDir = fakeProc({ 300: { ppid: 1, pgrp: 300, uid: MIND_UID, env: [OURS] } });
    const at: [string, number][] = [];
    const t0 = Date.now();
    const kill = (_pid: number, sig: string | 0) => {
      if (sig !== 0) at.push([String(sig), Date.now() - t0]);
    };
    await sweepMindProcesses(MIND_UID, MIND, { procDir, kill, ancestor: DAEMON, killAt: t0 + 700 });
    assert.equal(at[0][0], "SIGTERM");
    assert.ok(at[0][1] < 300, "the SIGTERM goes out at once");
    assert.equal(at[1][0], "SIGKILL");
    assert.ok(at[1][1] >= 650, `the SIGKILL waits for killAt (${at[1][1]}ms)`);
  });

  it("refuses root and the daemon's own uid", async () => {
    const procDir = fakeProc({ 300: { ppid: 1, pgrp: 300, uid: 0, env: [OURS] } });
    const { sent, kill } = recorder();
    assert.equal(await sweepMindProcesses(0, MIND, opts(procDir, kill)), 0);
    if (process.getuid) {
      writeProc(procDir, 301, { ppid: 1, pgrp: 301, uid: process.getuid(), env: [OURS] });
      assert.equal(await sweepMindProcesses(process.getuid(), MIND, opts(procDir, kill)), 0);
    }
    assert.deepEqual(sent, []);
  });

  it("survives a ppid cycle", async () => {
    const procDir = fakeProc({
      300: { ppid: 301, pgrp: 300, uid: MIND_UID, env: [OURS] },
      301: { ppid: 300, pgrp: 300, uid: MIND_UID, env: [OURS] },
    });
    const { sent, kill } = recorder((pid) =>
      rmSync(resolve(procDir, String(pid)), { recursive: true }),
    );
    assert.equal(await sweepMindProcesses(MIND_UID, MIND, opts(procDir, kill)), 2);
    assert.equal(sent.length, 2);
  });

  it("does nothing, quietly, without /proc", { skip: process.platform === "linux" }, async () => {
    const { sent, kill } = recorder();
    const logs: string[] = [];
    log.setOutput((line) => logs.push(line));
    try {
      assert.equal(
        await sweepMindProcesses(MIND_UID, MIND, { ancestor: DAEMON, killAt: 0, kill }),
        0,
      );
    } finally {
      log.setOutput((line) => process.stderr.write(`${line}\n`));
    }
    assert.deepEqual(sent, []);
    assert.deepEqual(logs, []);
  });
});
