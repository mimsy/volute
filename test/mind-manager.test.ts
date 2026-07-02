import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { MindManager } from "../packages/daemon/src/lib/daemon/mind-manager.js";
import { addMind, removeMind } from "../packages/daemon/src/lib/mind/registry.js";

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

describe("MindManager.stopMind kill timer", () => {
  it("clears the SIGKILL timer on a clean exit", async () => {
    await addMind("stopper-test", 4993);
    const killSignals: string[] = [];
    const origKill = process.kill.bind(process);
    // Stub process.kill so the fake pid never touches a real process group.
    (process as AnyMgr).kill = (_pid: number, sig?: string | number) => {
      if (typeof sig === "string") killSignals.push(sig);
      return true;
    };
    try {
      const mgr = new MindManager() as AnyMgr;
      const child = new EventEmitter() as AnyMgr;
      child.pid = 999999;
      mgr.minds.set("stopper-test", { child, port: 4993 });

      const p = mgr.stopMind("stopper-test");
      // Let withLock's microtask run so the exit listener + SIGTERM are wired up.
      await delay(5);
      child.emit("exit", 0);
      await p;

      assert.ok(killSignals.includes("SIGTERM"), "sent SIGTERM to the group");
      assert.ok(!killSignals.includes("SIGKILL"), "clean exit disarms the SIGKILL timer");
    } finally {
      (process as AnyMgr).kill = origKill;
      await removeMind("stopper-test");
    }
  });
});
