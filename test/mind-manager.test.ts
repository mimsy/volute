import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { MindManager } from "../packages/daemon/src/lib/daemon/mind-manager.js";
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
    const child = spawn("sh", ["-c", "sleep 30 & wait"], { detached: true, stdio: "ignore" });
    const pgid = child.pid!;
    await delay(100); // let sh fork the sleep
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
      await delay(50); // withLock + the group scan
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
