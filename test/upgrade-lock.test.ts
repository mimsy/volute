import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { withUpgradeLock } from "../packages/daemon/src/lib/mind/upgrade.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("withUpgradeLock", () => {
  it("serializes concurrent operations for the same mind name", async () => {
    const order: string[] = [];
    const first = deferred<void>();

    const p1 = withUpgradeLock("mind-a", async () => {
      order.push("start-1");
      await first.promise;
      order.push("end-1");
    });

    // Let p1 actually start — the lock is initially free.
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(order, ["start-1"]);

    const p2 = withUpgradeLock("mind-a", async () => {
      order.push("start-2");
    });

    // p2 must stay queued behind p1, not start early.
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(order, ["start-1"]);

    first.resolve();
    await Promise.all([p1, p2]);
    assert.deepEqual(order, ["start-1", "end-1", "start-2"]);
  });

  it("does not serialize operations for different mind names", async () => {
    const order: string[] = [];
    const first = deferred<void>();

    const p1 = withUpgradeLock("mind-a2", async () => {
      order.push("a-start");
      await first.promise;
      order.push("a-end");
    });
    await new Promise((r) => setTimeout(r, 10));

    const p2 = withUpgradeLock("mind-b2", async () => {
      order.push("b-start");
    });
    await p2;

    // A different mind's op runs before mind-a2's finishes — different keys don't block.
    assert.deepEqual(order, ["a-start", "b-start"]);
    first.resolve();
    await p1;
  });

  it("a rejected operation does not block the next queued operation for the same mind", async () => {
    const order: string[] = [];

    const p1 = withUpgradeLock("mind-c", async () => {
      order.push("1");
      throw new Error("boom");
    });

    const p2 = withUpgradeLock("mind-c", async () => {
      order.push("2");
    });

    await assert.rejects(p1, /boom/);
    await p2;
    assert.deepEqual(order, ["1", "2"]);
  });

  it("returns the operation's resolved value", async () => {
    const result = await withUpgradeLock("mind-d", async () => 42);
    assert.equal(result, 42);
  });
});
