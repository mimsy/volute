import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { BridgeManager } from "../packages/daemon/src/lib/daemon/bridge-manager.js";
import { MindManager } from "../packages/daemon/src/lib/daemon/mind-manager.js";
import { RestartTracker } from "../packages/daemon/src/lib/daemon/restart-tracker.js";
import { voluteSystemDir } from "../packages/daemon/src/lib/mind/registry.js";
import log from "../packages/daemon/src/lib/util/logger.js";

// #1033: both managers cleared the restart budget when the child was *spawned*,
// so a child that started and died immediately reset its own budget every time —
// the backoff stayed at the base delay and the give-up cap was unreachable. These
// drive the managers' real crash-recovery paths, with the tracker retuned so a
// full crash loop takes ~2s instead of ~93s.

// Tests reach into private members of the managers.
type AnyMgr = any;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `cond` holds, so a loaded machine gets more time rather than a flake. */
async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await delay(25);
  }
  return cond();
}

let fixtureDir: string;

/** A bridge fixture that appends a spawn timestamp, then behaves as told. */
function writeFixture(name: string, markerPath: string, body: string): string {
  const path = resolve(fixtureDir, `${name}.cjs`);
  writeFileSync(
    path,
    `require("node:fs").appendFileSync(${JSON.stringify(markerPath)}, Date.now() + "\\n");\n${body}\n`,
  );
  return path;
}

function spawnTimes(markerPath: string): number[] {
  if (!existsSync(markerPath)) return [];
  return readFileSync(markerPath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => Number(l));
}

describe("crash recovery wiring", () => {
  const capturedLogs: string[] = [];
  let restoreOutput: (() => void) | undefined;
  let priorToken: string | undefined;

  before(() => {
    fixtureDir = mkdtempSync(resolve(tmpdir(), "volute-restart-"));
    priorToken = process.env.VOLUTE_DAEMON_TOKEN;
    process.env.VOLUTE_DAEMON_TOKEN = "test-token";
    log.setOutput((line) => {
      capturedLogs.push(line);
    });
    restoreOutput = () => log.setOutput((line) => process.stderr.write(`${line}\n`));
  });

  after(() => {
    restoreOutput?.();
    rmSync(fixtureDir, { recursive: true, force: true });
    if (priorToken === undefined) delete process.env.VOLUTE_DAEMON_TOKEN;
    else process.env.VOLUTE_DAEMON_TOKEN = priorToken;
  });

  describe("BridgeManager", () => {
    it("gives up on a bridge that dies immediately, backing off as it goes", async () => {
      const marker = resolve(fixtureDir, "crash-spawns.txt");
      const mgr = new BridgeManager() as AnyMgr;
      mgr.restartTracker = new RestartTracker({ maxAttempts: 3, baseDelay: 300, maxDelay: 2000 });
      mgr.resolveBuiltinBridge = () => writeFixture("crash", marker, "process.exit(1);");

      const from = capturedLogs.length;
      await mgr.startBridge("crashy", 1618);

      // 300 + 600 + 1200 of backoff, plus spawn overhead.
      const msgs = () => capturedLogs.slice(from).map((l) => JSON.parse(l).msg as string);
      const gaveUp = await waitFor(
        () => msgs().includes("bridge crashy crashed 3 times — giving up"),
        15000,
      );
      assert.ok(gaveUp, "the manager never gave up");

      const times = spawnTimes(marker);
      assert.equal(times.length, 4, `expected 1 spawn + 3 restarts, got ${times.length}`);

      const gaps = times.slice(1).map((t, i) => t - times[i]);
      assert.ok(gaps[0] >= 250, `first backoff too short: ${gaps[0]}ms`);
      assert.ok(gaps[1] >= 550, `second backoff did not grow: ${gaps[1]}ms`);
      assert.ok(gaps[2] >= 1100, `third backoff did not grow: ${gaps[2]}ms`);

      assert.deepEqual(
        msgs()
          .filter((m) => m.startsWith("restarting bridge crashy"))
          .map((m) => m.split(" — ")[1]),
        ["attempt 1/3, in 300ms", "attempt 2/3, in 600ms", "attempt 3/3, in 1200ms"],
      );

      assert.equal(mgr.restartTracker.getAttempts("crashy"), 3);

      // And it stays given up: no further spawns.
      await delay(700);
      assert.equal(spawnTimes(marker).length, 4);
    });

    it("clears the budget once a bridge stays up past the threshold", async () => {
      const marker = resolve(fixtureDir, "healthy-spawns.txt");
      const mgr = new BridgeManager() as AnyMgr;
      const baseDelay = 1000;
      mgr.restartTracker = new RestartTracker({ maxAttempts: 3, baseDelay, maxDelay: 2000 });
      mgr.resolveBuiltinBridge = () =>
        writeFixture("healthy", marker, "setTimeout(() => {}, 10000);");

      mgr.restartTracker.recordCrash("healthy");
      mgr.restartTracker.recordCrash("healthy");
      assert.equal(mgr.restartTracker.getAttempts("healthy"), 2);

      const startedAt = Date.now();
      await mgr.startBridge("healthy", 1618);
      // Only meaningful if the spawn itself came in under the threshold; on a
      // badly loaded machine it may not, and asserting anyway would just flake.
      if (Date.now() - startedAt < baseDelay) {
        assert.equal(
          mgr.restartTracker.getAttempts("healthy"),
          2,
          "not cleared before the threshold",
        );
      }

      assert.ok(
        await waitFor(() => mgr.restartTracker.getAttempts("healthy") === 0, 5000),
        "staying up past the threshold must clear the budget",
      );

      await mgr.stopBridge("healthy");
      assert.equal(spawnTimes(marker).length, 1, "an operator stop must not restart it");
    });

    it("does not spend a restart attempt when an operator replaces a running bridge", async () => {
      const marker = resolve(fixtureDir, "replace-spawns.txt");
      const mgr = new BridgeManager() as AnyMgr;
      mgr.restartTracker = new RestartTracker({ maxAttempts: 3, baseDelay: 300, maxDelay: 2000 });
      mgr.resolveBuiltinBridge = () =>
        writeFixture("replace", marker, "setTimeout(() => {}, 10000);");

      await mgr.startBridge("replace", 1618);
      assert.ok(
        await waitFor(() => spawnTimes(marker).length === 1, 5000),
        "the first bridge never came up",
      );

      const from = capturedLogs.length;
      // What `POST /api/bridges/:platform` does to change defaultMind on a
      // running bridge: the deliberate kill must not read as a crash.
      await mgr.startBridge("replace", 1618);
      assert.ok(
        await waitFor(() => spawnTimes(marker).length >= 2, 5000),
        "the replacement never came up",
      );

      // Past the base delay, so a spurious crash restart would have fired by now.
      await delay(700);
      assert.equal(mgr.restartTracker.getAttempts("replace"), 0);
      assert.deepEqual(
        capturedLogs
          .slice(from)
          .map((l) => JSON.parse(l).msg as string)
          .filter((m) => m.startsWith("restarting bridge replace")),
        [],
      );
      assert.equal(spawnTimes(marker).length, 2, "the replacement must not be restarted on top of");

      await mgr.stopBridge("replace");
    });
  });

  describe("MindManager", () => {
    function fakeChild(): EventEmitter & { pid: number } {
      const child = new EventEmitter() as EventEmitter & { pid: number };
      child.pid = 0;
      return child;
    }

    it("clears the budget once a mind stays up past the threshold", async () => {
      const mgr = new MindManager() as AnyMgr;
      mgr.restartTracker = new RestartTracker({ maxAttempts: 3, baseDelay: 200, maxDelay: 2000 });
      mgr.restartTracker.recordCrash("stayer");
      mgr.restartTracker.recordCrash("stayer");
      mgr.saveCrashAttempts();
      const attemptsFile = resolve(voluteSystemDir(), "crash-attempts.json");
      assert.equal(JSON.parse(readFileSync(attemptsFile, "utf-8")).stayer, 2);

      const child = fakeChild();
      mgr.minds.set("stayer", { child, port: 4999 });
      mgr.setupCrashRecovery("stayer", child);

      assert.equal(mgr.restartTracker.getAttempts("stayer"), 2, "not cleared before the threshold");
      assert.ok(
        await waitFor(() => mgr.restartTracker.getAttempts("stayer") === 0, 5000),
        "staying up past the threshold must clear the budget",
      );

      // The reset is persisted, not just held in memory.
      assert.equal(JSON.parse(readFileSync(attemptsFile, "utf-8")).stayer, undefined);

      mgr.shuttingDown = true;
    });

    it("keeps the count when a mind dies before the threshold", async () => {
      const mgr = new MindManager() as AnyMgr;
      mgr.restartTracker = new RestartTracker({ maxAttempts: 3, baseDelay: 200, maxDelay: 2000 });

      const child = fakeChild();
      mgr.minds.set("dier", { child, port: 4998 });
      mgr.setupCrashRecovery("dier", child);
      child.emit("exit", 1);

      await delay(500);
      // Had the pending reset survived the exit, this would be back to 0 and the
      // mind would restart forever on the base delay.
      assert.equal(mgr.restartTracker.getAttempts("dier"), 1);

      mgr.shuttingDown = true;
    });
  });
});
