import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runShutdown } from "../templates/_base/src/lib/startup.js";

describe("runShutdown", () => {
  it("awaits the teardown before resolving", async () => {
    let torn = false;
    let release: () => void = () => {};
    const teardown = () =>
      new Promise<void>((resolve) => {
        release = () => {
          torn = true;
          resolve();
        };
      });

    let done = false;
    const p = runShutdown(teardown, 10_000).then(() => {
      done = true;
    });

    await Promise.resolve();
    assert.equal(done, false, "must not resolve while teardown is pending");
    assert.equal(torn, false);

    release();
    await p;
    assert.equal(torn, true);
    assert.equal(done, true);
  });

  it("resolves via timeout when the teardown wedges (bounded shutdown)", async () => {
    // A teardown that never resolves — runShutdown must still return via timeout.
    const teardown = () => new Promise<void>(() => {});
    const start = Date.now();
    await runShutdown(teardown, 20);
    assert.ok(Date.now() - start >= 20, "should wait at least the timeout");
  });

  it("swallows teardown errors so the process can still exit", async () => {
    const teardown = () => Promise.reject(new Error("boom"));
    await assert.doesNotReject(() => runShutdown(teardown, 10_000));
  });

  it("no-ops when no teardown is provided", async () => {
    await assert.doesNotReject(() => runShutdown(undefined, 10_000));
  });
});
