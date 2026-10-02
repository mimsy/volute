import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { MindManager, stopSparesLeader } from "../packages/daemon/src/lib/daemon/mind-manager.js";
import { addMind, removeMind } from "../packages/daemon/src/lib/mind/registry.js";
import log from "../packages/daemon/src/lib/util/logger.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  /** Stop a fake tracked mind with process.kill stubbed; returns what was sent. */
  async function stopFake(
    entry: { supervised: boolean },
    opts: { procDir?: string } = {},
  ): Promise<[number, string][]> {
    const name = `stopper-${Math.random().toString(36).slice(2, 8)}`;
    await addMind(name, 4993);
    const sent: [number, string][] = [];
    const origKill = process.kill.bind(process);
    // Stub process.kill so the fake pid never touches a real process group.
    (process as AnyMgr).kill = (pid: number, sig?: string | number) => {
      if (typeof sig === "string") sent.push([pid, sig]);
      return true;
    };
    try {
      const mgr = new MindManager() as AnyMgr;
      if (opts.procDir) mgr.procDir = opts.procDir;
      const child = new EventEmitter() as AnyMgr;
      Object.assign(child, { pid: 999999, exitCode: null, signalCode: null });
      mgr.minds.set(name, { child, port: 4993, ...entry });
      const p = mgr.stopMind(name);
      // Let withLock and the group scan run so the SIGTERM is out.
      await delay(20);
      child.emit("exit", 0);
      await p;
      await delay(20);
      return sent;
    } finally {
      (process as AnyMgr).kill = origKill;
      await removeMind(name);
    }
  }

  it("SIGTERMs an unsupervised mind's group, and sweeps it once on a clean exit", async () => {
    // The sweep goes out at once, never from a timer: a clean exit disarms the
    // deadline, so no stray group-SIGKILL can later fire against a reused pgid.
    assert.deepEqual(await stopFake({ supervised: false }), [
      [-999999, "SIGTERM"],
      [-999999, "SIGKILL"],
    ]);
  });

  it("signals a runuser-supervised mind's processes past runuser (#1364)", async () => {
    const proc = mkdtempSync(resolve(tmpdir(), "fake-proc-"));
    try {
      for (const [pid, comm] of [
        [999999, "runuser"],
        [1000000, "node"],
      ] as const) {
        mkdirSync(resolve(proc, String(pid)));
        writeFileSync(
          resolve(proc, String(pid), "stat"),
          `${pid} (${comm}) S 1 999999 999999 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${pid} 0 0\n`,
        );
      }
      assert.deepEqual(await stopFake({ supervised: true }, { procDir: proc }), [
        [1000000, "SIGTERM"],
        [-999999, "SIGKILL"],
      ]);
    } finally {
      rmSync(proc, { recursive: true, force: true });
    }
  });

  it("falls back to the group, and logs it, when a supervised mind can't be listed", async () => {
    const lines: string[] = [];
    log.setOutput((line) => lines.push(line));
    try {
      const sent = await stopFake({ supervised: true }, { procDir: "/nonexistent-proc" });
      assert.deepEqual(sent[0], [-999999, "SIGTERM"]);
      assert.ok(lines.some((l) => l.includes("could not list process group 999999")));
    } finally {
      log.setOutput((line) => process.stderr.write(`${line}\n`));
    }
  });
});

describe("stopSparesLeader", () => {
  const platform = process.platform;
  const isolation = process.env.VOLUTE_ISOLATION;
  const on = (p: string) => Object.defineProperty(process, "platform", { value: p });

  it("is true only for user isolation on Linux, where runuser leads the group", () => {
    try {
      process.env.VOLUTE_ISOLATION = "user";
      on("linux");
      assert.equal(stopSparesLeader("user"), true);
      assert.equal(stopSparesLeader("sandbox"), false);
      assert.equal(stopSparesLeader("none"), false);
      on("darwin"); // sudo relays the SIGTERM and has no timed kill
      assert.equal(stopSparesLeader("user"), false);
    } finally {
      on(platform);
      if (isolation === undefined) delete process.env.VOLUTE_ISOLATION;
      else process.env.VOLUTE_ISOLATION = isolation;
    }
  });
});
