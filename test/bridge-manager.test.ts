import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BridgeManager } from "../packages/daemon/src/lib/daemon/bridge-manager.js";
import { RestartTracker } from "../packages/daemon/src/lib/daemon/restart-tracker.js";

function startsIn(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").split("\n").filter(Boolean).length;
}

async function waitForStarts(path: string, expected: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (startsIn(path) < expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(startsIn(path), expected, `expected ${expected} bridge starts`);
}

describe("BridgeManager crash recovery", () => {
  it("lets an immediate crash loop reach the restart cap", async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "volute-bridge-crash-loop-"));
    const markerPath = join(fixtureDir, "starts.log");
    const fixturePath = join(fixtureDir, "immediate-exit.mjs");
    writeFileSync(
      fixturePath,
      [
        'import { appendFileSync } from "node:fs";',
        `appendFileSync(${JSON.stringify(markerPath)}, "start\\n");`,
        "process.exit(1);",
      ].join("\n"),
    );

    const previousToken = process.env.VOLUTE_DAEMON_TOKEN;
    process.env.VOLUTE_DAEMON_TOKEN = "bridge-manager-test-token";

    const manager = new BridgeManager();
    const internals = manager as unknown as {
      restartTracker: RestartTracker;
      resolveBuiltinBridge: () => string;
      killOrphanBridge: () => void;
      saveBridgePid: () => void;
    };
    const maxAttempts = 2;
    internals.restartTracker = new RestartTracker({ maxAttempts, baseDelay: 0, maxDelay: 0 });
    internals.resolveBuiltinBridge = () => fixturePath;
    internals.killOrphanBridge = () => {};
    internals.saveBridgePid = () => {};

    try {
      await manager.startBridge("discord", 0);
      await waitForStarts(markerPath, maxAttempts + 1);
      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.equal(startsIn(markerPath), maxAttempts + 1);
      assert.equal(internals.restartTracker.getAttempts("discord"), maxAttempts);
    } finally {
      await manager.stopAll();
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (previousToken === undefined) delete process.env.VOLUTE_DAEMON_TOKEN;
      else process.env.VOLUTE_DAEMON_TOKEN = previousToken;
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
