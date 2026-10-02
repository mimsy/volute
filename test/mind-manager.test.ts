import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { isOurMindServer, MindManager } from "../packages/daemon/src/lib/daemon/mind-manager.js";
import {
  addMind,
  mindDir,
  removeMind,
  stateDir,
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
    const calls: { uid: number; name: string; opts: AnyMgr }[] = [];
    mgr.mindOwner = async () => ({ uid: 1234, gid: 1234 });
    mgr.sweepMindProcesses = async (uid: number, name: string, opts: AnyMgr) => {
      calls.push({ uid, name, opts });
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

  it("a stop sweeps the stopped mind's processes, sparing the daemon's children", () =>
    withIsolation(async () => {
      const { mgr, calls } = sweeper();
      const name = `sweeper-${Math.random().toString(36).slice(2, 8)}`;
      await addMind(name, 4994);
      const child = spawn("true", [], { detached: true, stdio: "ignore" });
      await new Promise((r) => child.once("exit", r));
      // A variant running as the same user doesn't hold the sweep off: its jobs carry
      // its own name.
      mgr.minds.set(`${name}-v`, { child, port: 4995, baseName: name, supervised: false });
      try {
        mgr.minds.set(name, { child, port: 4994, baseName: name, supervised: false });
        await mgr.stopMind(name);
      } finally {
        await removeMind(name);
      }
      assert.equal(calls.length, 1);
      assert.equal(calls[0].uid, 1234);
      assert.equal(calls[0].name, name);
      assert.equal(calls[0].opts.ancestor, process.pid);
    }));

  it("a start sweeps before it spawns, and an early exit is reported as one", async () => {
    const name = `sweepstart-${Math.random().toString(36).slice(2, 8)}`;
    await addMind(name, 4997);
    mkdirSync(mindDir(name), { recursive: true }); // no src/server.ts: the server exits at once
    const mgr = new MindManager() as AnyMgr;
    const order: string[] = [];
    mgr.sweepMindUser = async (n: string, base: string) => order.push(`sweep ${n} ${base}`);
    // An identity read slower than the server's exit must not hide that exit.
    mgr.processIdentity = async () => {
      await delay(3000);
      return null;
    };
    try {
      await assert.rejects(mgr.startMind(name, { healthTimeoutMs: 2000 }), /exited with code/);
      assert.deepEqual(order, [`sweep ${name} ${name}`]);
      assert.ok(
        !existsSync(resolve(stateDir(name), "mind.pid")),
        "a failed start leaves no PID file",
      );
    } finally {
      await removeMind(name);
    }
  });

  it("never sweeps without user isolation, or the spirit's user", async () => {
    const { mgr, calls } = sweeper();
    await mgr.sweepMindUser("m", "m");
    await withIsolation(() => mgr.sweepMindUser("volute", "volute"));
    assert.equal(calls.length, 0);
    await withIsolation(() => mgr.sweepMindUser("m", "m"));
    assert.equal(calls.length, 1);
  });
});

describe("MindManager stale mind.pid (#1366)", () => {
  const PORT = 4996;
  const serverArgs = (port = PORT) =>
    `runuser -u mind-x -- /usr/bin/node --import tsx src/server.ts --port ${port}`;

  /**
   * A real detached process standing in for a previous daemon's orphan, a `mind.pid`
   * naming it, and the identity the OS is said to report for it. Returns whether the
   * process was signalled, and whether the PID file is gone.
   */
  async function stale(
    fileText: (pid: number) => string,
    identity: { args: string; start: string; boot: string | null } | null,
    port = PORT,
  ): Promise<{ signalled: boolean; removed: boolean }> {
    const name = `stale-${Math.random().toString(36).slice(2, 8)}`;
    const dir = stateDir(name);
    mkdirSync(dir, { recursive: true });
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    const exited = new Promise<boolean>((r) => child.once("exit", () => r(true)));
    writeFileSync(resolve(dir, "mind.pid"), fileText(child.pid!));
    const mgr = new MindManager() as AnyMgr;
    mgr.processIdentity = async () => identity;
    try {
      await mgr.killStaleMind(name, port, null);
      const signalled = await Promise.race([exited, delay(300).then(() => false)]);
      return { signalled, removed: !existsSync(resolve(dir, "mind.pid")) };
    } finally {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
    }
  }

  const record = (pid: number) => JSON.stringify({ pid, start: "777", boot: "b1" });

  it("stops the process when it is still this mind's server", async () => {
    const r = await stale(record, { args: serverArgs(), start: "777", boot: "b1" });
    assert.deepEqual(r, { signalled: true, removed: true });
  });

  it("recognises the server inside the sandbox's wrap, on macOS and Linux", async () => {
    const fixture = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "fixtures/sandbox-wrapped-server.json"), "utf-8"),
    );
    for (const platform of ["darwin", "linux"]) {
      const args = (fixture[platform] as string[]).join(" ");
      const id = { args, start: "777", boot: "b1" };
      assert.equal(isOurMindServer(fixture.port, { pid: 1, start: "777", boot: "b1" }, id), true);
      assert.equal(
        isOurMindServer(fixture.port + 1, { pid: 1, start: null, boot: null }, id),
        false,
      );
    }
    assert.deepEqual(
      await stale(
        record,
        {
          args: (fixture.linux as string[]).join(" "),
          start: "777",
          boot: "b1",
        },
        fixture.port,
      ),
      { signalled: true, removed: true },
    );
  });

  it("never signals a reused pid: another command, another port, another start, another boot", async () => {
    for (const id of [
      { args: "node other-dev-server/server.ts --port 4996", start: "777", boot: "b1" },
      { args: "node src/server.ts --port 49960", start: "777", boot: "b1" },
      { args: serverArgs(PORT + 1), start: "777", boot: "b1" },
      { args: serverArgs(), start: "778", boot: "b1" },
      { args: serverArgs(), start: "777", boot: "b2" },
    ]) {
      assert.deepEqual(await stale(record, id), { signalled: false, removed: true }, id.args);
    }
  });

  it("checks an older daemon's bare-pid file by its command line alone", async () => {
    const bare = (pid: number) => `${pid}\n`;
    assert.deepEqual(await stale(bare, { args: serverArgs(), start: "1", boot: null }), {
      signalled: true,
      removed: true,
    });
    assert.deepEqual(
      await stale(bare, { args: "vite --port 4996 server.ts", start: "1", boot: null }),
      { signalled: false, removed: true },
    );
  });

  it("removes the file without signalling when the process can't be read", async () => {
    assert.deepEqual(await stale(record, null), { signalled: false, removed: true });
  });

  it("records the pid at once, then the identity, and no identity for a server already gone", async () => {
    const name = `pidrec-${Math.random().toString(36).slice(2, 8)}`;
    const dir = stateDir(name);
    mkdirSync(dir, { recursive: true });
    const pidFile = () => JSON.parse(readFileSync(resolve(dir, "mind.pid"), "utf-8"));
    const mgr = new MindManager() as AnyMgr;
    let seenAtRead: unknown;
    mgr.processIdentity = async () => {
      seenAtRead = pidFile();
      return { args: serverArgs(), start: "4242", boot: "bx" };
    };
    const child = { pid: 9999, exitCode: null, signalCode: null };
    await mgr.saveMindPid(name, child, null);
    assert.deepEqual(seenAtRead, { pid: 9999, start: null, boot: null });
    assert.deepEqual(pidFile(), { pid: 9999, start: "4242", boot: "bx" });

    const gone = { pid: 9998, exitCode: 1, signalCode: null };
    await mgr.saveMindPid(name, gone, null);
    assert.deepEqual(pidFile(), { pid: 9998, start: null, boot: null });
  });
});
