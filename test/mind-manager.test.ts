import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { isOurMindServer, MindManager } from "../packages/daemon/src/lib/daemon/mind-manager.js";
import {
  addMind,
  mindDir,
  removeMind,
  stateDir,
  voluteSystemDir,
} from "../packages/daemon/src/lib/mind/registry.js";
import log from "../packages/daemon/src/lib/util/logger.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll `cond` until it holds, failing with `what` after `ms`. */
async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms}ms waiting for ${what}`);
    await delay(10);
  }
}

// Tests reach into private members of MindManager.
type AnyMgr = any;

describe("MindManager.withLock", () => {
  it("serializes concurrent ops for the same name", async () => {
    const mgr = new MindManager() as AnyMgr;
    const order: string[] = [];
    const p1 = mgr.withLock("m", async () => {
      order.push("1-start");
      await delay(25);
      order.push("1-end");
    });
    const p2 = mgr.withLock("m", async () => {
      order.push("2-start");
      await delay(1);
      order.push("2-end");
    });
    await Promise.all([p1, p2]);
    // The second op must not start until the first finishes.
    assert.deepEqual(order, ["1-start", "1-end", "2-start", "2-end"]);
  });

  it("runs different names concurrently", async () => {
    const mgr = new MindManager() as AnyMgr;
    const order: string[] = [];
    const a = mgr.withLock("a", async () => {
      order.push("a-start");
      await delay(25);
      order.push("a-end");
    });
    const b = mgr.withLock("b", async () => {
      order.push("b-start");
      await delay(1);
      order.push("b-end");
    });
    await Promise.all([a, b]);
    assert.deepEqual(order, ["a-start", "b-start", "b-end", "a-end"]);
  });

  it("a rejection does not break the chain for later callers", async () => {
    const mgr = new MindManager() as AnyMgr;
    await assert.rejects(
      mgr.withLock("m", async () => {
        throw new Error("boom");
      }),
    );
    let ran = false;
    await mgr.withLock("m", async () => {
      ran = true;
    });
    assert.ok(ran);
  });
});

describe("MindManager.startMind serialization", () => {
  it("two concurrent startMind calls track exactly one child", async () => {
    const mgr = new MindManager() as AnyMgr;
    const minds: Map<string, unknown> = mgr.minds;
    // Replace the heavy internal implementation with a fake spawn that mirrors
    // the real re-check-inside-lock + track semantics.
    mgr._startMind = async (name: string) => {
      if (minds.has(name)) throw new Error(`Mind ${name} is already running`);
      await delay(10);
      minds.set(name, { child: new EventEmitter(), port: 1 });
    };

    const results = await Promise.allSettled([mgr.startMind("m"), mgr.startMind("m")]);
    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected").length;

    assert.equal(fulfilled, 1);
    assert.equal(rejected, 1);
    assert.equal(minds.size, 1);
    assert.ok((minds.get("m") as { child: unknown })?.child, "the winner's entry survives");
  });
});

describe("MindManager crash-recovery exit guard", () => {
  it("ignores an exit from a child that was already replaced", async () => {
    const mgr = new MindManager() as AnyMgr;
    const minds: Map<string, unknown> = mgr.minds;
    const oldChild = new EventEmitter();
    const newChild = new EventEmitter();
    // A restart already swapped in a new child under the same name.
    minds.set("m", { child: newChild, port: 2 });
    // The crash handler was registered on the OLD child.
    mgr.setupCrashRecovery("m", oldChild);

    oldChild.emit("exit", 1);
    await delay(10);

    assert.equal((minds.get("m") as { child: unknown })?.child, newChild);
  });
});

describe("MindManager.stopMind signals", () => {
  /**
   * Stop a tracked mind whose process is a real detached `sh` with a `sleep`
   * below it, with process.kill stubbed so nothing is actually signalled; returns
   * what was sent and logged.
   */
  async function stopTracked(
    supervised: boolean,
  ): Promise<{ sent: [number, string][]; logs: string[]; pgid: number }> {
    const name = `stopper-${Math.random().toString(36).slice(2, 8)}`;
    await addMind(name, 4993);
    // sh prints the sleep's pid once it has forked it, so the group has a member
    // below its leader before the stop looks for one.
    const child = spawn("sh", ["-c", "sleep 30 & echo $!; wait"], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pgid = child.pid!;
    let forked = false;
    child.stdout!.once("data", () => {
      forked = true;
    });
    await until(() => forked, 5_000, "sh to fork the sleep");
    const sent: [number, string][] = [];
    const logs: string[] = [];
    const origKill = process.kill.bind(process);
    (process as AnyMgr).kill = (pid: number, sig?: string | number) => {
      if (typeof sig === "string") sent.push([pid, sig]);
      return true;
    };
    log.setOutput((line) => logs.push(line));
    try {
      const mgr = new MindManager() as AnyMgr;
      mgr.minds.set(name, { child, port: 4993, supervised });
      const p = mgr.stopMind(name);
      // withLock, then the group scan: done once the SIGTERM is out.
      await until(() => sent.length > 0, 5_000, "the stop's SIGTERM");
      (process as AnyMgr).kill = origKill;
      process.kill(-pgid, "SIGKILL"); // end it for real, as the stub didn't
      await p;
      return { sent, logs, pgid };
    } finally {
      (process as AnyMgr).kill = origKill;
      log.setOutput((line) => process.stderr.write(`${line}\n`));
      await removeMind(name);
    }
  }

  it("SIGTERMs an unsupervised mind's group, and no SIGKILL follows its exit", async () => {
    const { sent, logs, pgid } = await stopTracked(false);
    assert.deepEqual(sent, [[-pgid, "SIGTERM"]]);
    assert.ok(!logs.some((l) => l.includes("could not scan")), "no scan for an unsupervised stop");
  });

  it("signals a runuser-supervised mind past its leader (#1364)", async () => {
    const { sent, logs, pgid } = await stopTracked(true);
    assert.equal(sent.length, 1);
    if (process.platform === "linux") {
      // The sleep below the leader, never the leader or its group.
      assert.notEqual(sent[0][0], pgid);
      assert.ok(sent[0][0] > 0);
      assert.equal(sent[0][1], "SIGTERM");
    } else {
      // No /proc to scan: the group fallback, and the log saying so.
      assert.deepEqual(sent, [[-pgid, "SIGTERM"]]);
      assert.ok(logs.some((l) => l.includes(`could not scan process group ${pgid}`)));
    }
  });
});

describe("MindManager sweep of what a mind left running (#1374)", () => {
  /** A manager whose sweep and owner lookup are stubbed; returns what it was asked to sweep. */
  function sweeper() {
    const mgr = new MindManager() as AnyMgr;
    const calls: { uid: number; name: string; opts: AnyMgr; at: number }[] = [];
    mgr.mindOwner = async () => ({ uid: 1234, gid: 1234 });
    mgr.sweepMindProcesses = async (uid: number, name: string, opts: AnyMgr) => {
      calls.push({ uid, name, opts, at: Date.now() });
      return 0;
    };
    return { mgr, calls };
  }

  async function withIsolation(fn: () => Promise<void>): Promise<void> {
    const prev = process.env.VOLUTE_ISOLATION;
    process.env.VOLUTE_ISOLATION = "user";
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.VOLUTE_ISOLATION;
      else process.env.VOLUTE_ISOLATION = prev;
    }
  }

  const freshName = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;

  it("a stop sweeps alongside the group, with the group's own grace", () =>
    withIsolation(async () => {
      const { mgr, calls } = sweeper();
      const name = freshName("sweeper");
      await addMind(name, 4994);
      // A leader that takes its time over a SIGTERM: the sweep must not wait for it.
      const child = spawn("sh", ["-c", 'trap "" TERM; sleep 1'], {
        detached: true,
        stdio: "ignore",
      });
      // A variant running as the same user doesn't hold the sweep off: its jobs carry
      // its own name.
      mgr.minds.set(`${name}-v`, { child, port: 4995, baseName: name, supervised: false });
      let exitedAt = Number.POSITIVE_INFINITY;
      child.once("exit", () => {
        exitedAt = Date.now();
      });
      const t0 = Date.now();
      try {
        mgr.minds.set(name, { child, port: 4994, baseName: name, supervised: false });
        await mgr.stopMind(name);
      } finally {
        await removeMind(name);
      }
      // Once at once, and again after the server exited, for what it still parented.
      assert.equal(calls.length, 2);
      for (const call of calls) {
        assert.equal(call.uid, 1234);
        assert.equal(call.name, name);
        assert.equal(call.opts.ancestor, process.pid);
        const killAt = call.opts.killAt - t0;
        assert.ok(killAt >= 4900 && killAt <= 5200, `killAt is the stop's 5s grace (${killAt}ms)`);
      }
      assert.ok(calls[0].at - t0 < 400, "swept while the group was still stopping");
      assert.equal(child.exitCode !== null || child.signalCode !== null, true);
      assert.ok(calls[1].at >= exitedAt, "swept again once the server had exited");
      assert.ok(mgr.lastSwept.has(name), "the post-exit scan counts");
    }));

  it("a stop during a recovery backoff sweeps too", () =>
    withIsolation(async () => {
      const { mgr, calls } = sweeper();
      const name = freshName("backoff");
      await addMind(name, 4998);
      mgr.recoveries.set(name, { timer: setTimeout(() => {}, 60_000) });
      try {
        await mgr.stopMind(name);
      } finally {
        await removeMind(name);
      }
      assert.deepEqual(
        calls.map((c) => c.name),
        [name],
      );
    }));

  it("giving up on crash recovery sweeps", () =>
    withIsolation(async () => {
      const { mgr, calls } = sweeper();
      const name = freshName("giveup");
      await addMind(name, 4999);
      mgr.restartTracker.recordCrash = () => ({ shouldRestart: false, delay: 0, attempt: 5 });
      try {
        await mgr.scheduleCrashRestart(name);
      } finally {
        await removeMind(name);
      }
      assert.deepEqual(
        calls.map((c) => c.name),
        [name],
      );
    }));

  it("sweepStopped skips a running mind, and one swept moments ago", () =>
    withIsolation(async () => {
      const { mgr, calls } = sweeper();
      const name = freshName("stopped");
      await addMind(name, 5000);
      try {
        mgr.minds.set(name, { child: new EventEmitter(), port: 5000, baseName: name });
        await mgr.sweepStopped(name);
        assert.equal(calls.length, 0, "running");
        mgr.minds.delete(name);
        await mgr.sweepStopped(name);
        assert.equal(calls.length, 1);
        await mgr.sweepStopped(name);
        assert.equal(calls.length, 1, "swept moments ago");
        mgr.lastSwept.set(name, Date.now() - 31_000);
        await mgr.sweepStopped(name);
        assert.equal(calls.length, 2);
        // A scan that may have spared what a live server parented doesn't count.
        mgr.lastSwept.delete(name);
        await mgr.sweepMindUser(name, name, Date.now(), { record: false });
        assert.ok(!mgr.lastSwept.has(name));
      } finally {
        await removeMind(name);
      }
    }));

  it("a start sweeps before it spawns, and an early exit is reported as one", async () => {
    const name = freshName("sweepstart");
    await addMind(name, 4997);
    mkdirSync(mindDir(name), { recursive: true }); // no src/server.ts: the server exits at once
    const mgr = new MindManager() as AnyMgr;
    const order: string[] = [];
    mgr.sweepMindUser = async (n: string, base: string, _killAt: number, opts: AnyMgr) =>
      order.push(`sweep ${n} ${base} ${!!opts?.unlessRecent}`);
    // An identity read slower than the server's exit must not hide that exit.
    mgr.processIdentity = async () => {
      await delay(3000);
      return null;
    };
    // A sweep before this run doesn't excuse the next start from sweeping what it leaves.
    mgr.lastSwept.set(name, Date.now());
    try {
      const t0 = Date.now();
      await assert.rejects(mgr.startMind(name, { healthTimeoutMs: 2000 }), /exited with code/);
      assert.ok(Date.now() - t0 < 2000, "reported at the exit, not at a timeout");
      assert.deepEqual(order, [`sweep ${name} ${name} true`]);
      assert.ok(!mgr.lastSwept.has(name), "it ran since its last sweep");
    } finally {
      await removeMind(name);
    }
  });

  it("never sweeps without user isolation, or the spirit's user", async () => {
    const { mgr, calls } = sweeper();
    await mgr.sweepMindUser("m", "m", Date.now());
    await withIsolation(() => mgr.sweepMindUser("volute", "volute", Date.now()));
    assert.equal(calls.length, 0);
    await withIsolation(() => mgr.sweepMindUser("m", "m", Date.now()));
    assert.equal(calls.length, 1);
  });
});

describe("MindManager stale PID record (#1366)", () => {
  const PORT = 4996;
  const serverArgv = (port = PORT) => [
    "runuser",
    "-u",
    "mind-x",
    "--",
    "/usr/bin/node",
    "--import",
    "tsx",
    "src/server.ts",
    "--port",
    String(port),
  ];
  const ident = (argv: string[], start = "777", boot: string | null = "b1") => ({
    args: argv.join(" "),
    argv,
    start,
    boot,
  });
  const recordPath = (name: string) => resolve(voluteSystemDir(), "mind-pids", `${name}.json`);

  /**
   * A real detached process standing in for a previous daemon's orphan, a PID record
   * naming it, and the identity the OS is said to report for it. Returns whether the
   * process was signalled, and whether the record is gone.
   */
  async function stale(
    recordText: ((pid: number) => string) | null,
    identity: ReturnType<typeof ident> | null,
    opts: { port?: number; stateDirText?: (pid: number) => string } = {},
  ): Promise<{ signalled: boolean; removed: boolean }> {
    const name = `stale-${Math.random().toString(36).slice(2, 8)}`;
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    const exited = new Promise<boolean>((r) => child.once("exit", () => r(true)));
    const path = recordPath(name);
    mkdirSync(dirname(path), { recursive: true });
    if (recordText) writeFileSync(path, recordText(child.pid!));
    if (opts.stateDirText) {
      mkdirSync(stateDir(name), { recursive: true });
      writeFileSync(resolve(stateDir(name), "mind.pid"), opts.stateDirText(child.pid!));
    }
    const mgr = new MindManager() as AnyMgr;
    mgr.processIdentity = async () => identity;
    try {
      await mgr.killStaleMind(name, opts.port ?? PORT);
      const signalled = await Promise.race([exited, delay(300).then(() => false)]);
      return { signalled, removed: !existsSync(path) };
    } finally {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
    }
  }

  const record = (pid: number) => JSON.stringify({ pid, start: "777", boot: "b1" });

  it("stops the process when it is still this mind's server", async () => {
    assert.deepEqual(await stale(record, ident(serverArgv())), { signalled: true, removed: true });
  });

  it("recognises the server behind the sandbox's wrap, on macOS and Linux", async () => {
    const fixture = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "fixtures/sandbox-wrapped-server.json"), "utf-8"),
    );
    for (const form of ["darwin", "linux", "darwinLeader", "linuxLeader"]) {
      const id = ident(fixture[form]);
      const rec = { pid: 2, start: "777", boot: "b1" };
      assert.equal(isOurMindServer(fixture.port, rec, id), true, form);
      assert.equal(isOurMindServer(fixture.port + 1, rec, id), false, form);
    }
    assert.deepEqual(await stale(record, ident(fixture.linuxLeader), { port: fixture.port }), {
      signalled: true,
      removed: true,
    });
  });

  it("never signals a reused pid: another command, another port, another start, another boot", async () => {
    for (const id of [
      ident(["node", "other-dev-server/server.ts", "--port", String(PORT)]),
      ident(["node", "src/server.ts", "--port", `${PORT}0`]),
      ident(["node", "src/server.ts.bak", "--port", String(PORT)]),
      // the words are all there, but not as this server's arguments
      ident(["sh", "-x", `echo src/server.ts --port ${PORT}`]),
      ident(serverArgv(PORT + 1)),
      ident(serverArgv(), "778"),
      ident(serverArgv(), "777", "b2"),
      ident(serverArgv(), "777", null),
    ]) {
      assert.deepEqual(await stale(record, id), { signalled: false, removed: true }, id.args);
    }
  });

  it("signals nothing for a record it can't vouch for: a bare pid, junk, or one without its identity", async () => {
    for (const text of [
      (pid: number) => `${pid}\n`,
      () => "{not json",
      (pid: number) => JSON.stringify({ pid }),
      (pid: number) => JSON.stringify({ pid, start: "777", boot: null }),
      () => JSON.stringify({ pid: 1, start: "777", boot: "b1" }),
    ]) {
      assert.deepEqual(await stale(text, ident(serverArgv())), { signalled: false, removed: true });
    }
  });

  it("never asks after a pid that would signal a group, every process, or init", async () => {
    const name = `badpid-${Math.random().toString(36).slice(2, 8)}`;
    const mgr = new MindManager() as AnyMgr;
    const asked: unknown[] = [];
    // Answers null, so a broken check fails here rather than signalling anything.
    mgr.processIdentity = async (pid: unknown) => {
      asked.push(pid);
      return null;
    };
    mkdirSync(dirname(recordPath(name)), { recursive: true });
    for (const pid of [0, -1, 1, 1.5, "4242", null]) {
      writeFileSync(recordPath(name), JSON.stringify({ pid, start: "777", boot: "b1" }));
      await mgr.killStaleMind(name, PORT);
      assert.ok(!existsSync(recordPath(name)), `record removed (${pid})`);
    }
    assert.deepEqual(asked, []);
  });

  it("ignores a pid file in the mind's own state dir", async () => {
    assert.deepEqual(await stale(null, ident(serverArgv()), { stateDirText: record }), {
      signalled: false,
      removed: true,
    });
  });

  it("matches a record and a process whose boot couldn't be read", async () => {
    const noBoot = (pid: number) => JSON.stringify({ pid, start: "777", boot: null });
    assert.deepEqual(await stale(noBoot, ident(serverArgv(), "777", null)), {
      signalled: true,
      removed: true,
    });
  });

  it("removes the record without signalling when the process can't be read", async () => {
    assert.deepEqual(await stale(record, null), { signalled: false, removed: true });
  });

  it("records a tracked server's identity, root-only, and nothing for one no longer tracked", async () => {
    const name = `pidrec-${Math.random().toString(36).slice(2, 8)}`;
    const mgr = new MindManager() as AnyMgr;
    mgr.processIdentity = async () => ident(serverArgv(), "4242", "bx");
    const child = { pid: 9999 };
    await mgr.saveMindPid(name, child);
    assert.ok(!existsSync(recordPath(name)), "an untracked child is not recorded");
    mgr.minds.set(name, { child, port: PORT, baseName: name, supervised: false });
    await mgr.saveMindPid(name, child);
    assert.deepEqual(JSON.parse(readFileSync(recordPath(name), "utf-8")), {
      pid: 9999,
      start: "4242",
      boot: "bx",
    });
    assert.equal(statSync(recordPath(name)).mode & 0o777, 0o600);
    // An unreadable boot is recorded as such, and still matches the process it names.
    mgr.processIdentity = async () => ident(serverArgv(), "4242", null);
    await mgr.saveMindPid(name, child);
    const rec = JSON.parse(readFileSync(recordPath(name), "utf-8"));
    assert.equal(rec.boot, null);
    assert.equal(isOurMindServer(PORT, rec, ident(serverArgv(), "4242", null)), true);
  });
});
