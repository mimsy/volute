import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { BridgeManager } from "../packages/daemon/src/lib/daemon/bridge-manager.js";
import {
  DaemonShuttingDownError,
  MindManager,
  MindStartupError,
  MindUnavailableError,
} from "../packages/daemon/src/lib/daemon/mind-manager.js";
import { RestartTracker } from "../packages/daemon/src/lib/daemon/restart-tracker.js";
import {
  addMind,
  findMind,
  setMindRunning,
  voluteSystemDir,
} from "../packages/daemon/src/lib/mind/registry.js";
import log from "../packages/daemon/src/lib/util/logger.js";
import { warmDeliveryPath } from "./helpers/warm-delivery.js";

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

    // #1352: the crashed child is untracked while its restart waits out the backoff, so
    // a disable used to find nothing to stop and the bridge respawned until the cap.
    it("a stop during crash backoff cancels the pending restart", async () => {
      const marker = resolve(fixtureDir, "disable-spawns.txt");
      const mgr = new BridgeManager() as AnyMgr;
      mgr.restartTracker = new RestartTracker({ maxAttempts: 3, baseDelay: 300, maxDelay: 2000 });
      mgr.resolveBuiltinBridge = () => writeFixture("disable", marker, "process.exit(1);");

      const from = capturedLogs.length;
      try {
        await mgr.startBridge("disable", 1618);
        const msgs = () => capturedLogs.slice(from).map((l) => JSON.parse(l).msg as string);
        assert.ok(
          await waitFor(() => msgs().some((m) => m.startsWith("restarting bridge disable")), 5000),
          "the crash restart was never scheduled",
        );

        await mgr.stopBridge("disable");

        await delay(700);
        assert.equal(spawnTimes(marker).length, 1, "a stopped bridge must not be respawned");
        assert.equal(mgr.restartTracker.getAttempts("disable"), 0);
      } finally {
        await mgr.stopBridge("disable");
      }
    });

    it("a crashed child's exit removes its PID file, and a stop after giving up clears the budget", async () => {
      const marker = resolve(fixtureDir, "gaveup-spawns.txt");
      const mgr = new BridgeManager() as AnyMgr;
      mgr.restartTracker = new RestartTracker({ maxAttempts: 1, baseDelay: 300, maxDelay: 2000 });
      mgr.resolveBuiltinBridge = () => writeFixture("gaveup", marker, "process.exit(1);");
      const pidPath = mgr.bridgePidPath("gaveup");

      const from = capturedLogs.length;
      try {
        await mgr.startBridge("gaveup", 1618);
        const msgs = () => capturedLogs.slice(from).map((l) => JSON.parse(l).msg as string);
        assert.ok(
          await waitFor(() => msgs().includes("bridge gaveup crashed 1 times — giving up"), 5000),
          "the manager never gave up",
        );
        assert.equal(spawnTimes(marker).length, 2);
        assert.equal(existsSync(pidPath), false, "the exited child left its PID file behind");
        // So the restart found no "orphan" to report — it was the child that just exited.
        assert.deepEqual(
          msgs().filter((m) => m.includes("orphan bridge gaveup")),
          [],
        );
        assert.equal(mgr.restartTracker.getAttempts("gaveup"), 1);

        // Nothing tracked, nothing pending: the stop still resets the spent budget and
        // removes a leftover PID file.
        writeFileSync(pidPath, "999999");
        await mgr.stopBridge("gaveup");
        assert.equal(mgr.restartTracker.getAttempts("gaveup"), 0);
        assert.equal(existsSync(pidPath), false);
      } finally {
        await mgr.stopBridge("gaveup");
      }
    });

    it("a superseded restart timer never fires", async () => {
      const mgr = new BridgeManager() as AnyMgr;
      let starts = 0;
      mgr.startBridge = async () => {
        starts++;
      };
      mgr.scheduleRestart("twice", 1618, 200);
      mgr.scheduleRestart("twice", 1618, 200);
      await delay(500);
      assert.equal(starts, 1);
      assert.equal(mgr.pendingRestarts.size, 0);
    });

    it("a stop wins over a start still terminating the bridge it replaces", async () => {
      const marker = resolve(fixtureDir, "race-spawns.txt");
      const mgr = new BridgeManager() as AnyMgr;
      mgr.restartTracker = new RestartTracker({ maxAttempts: 3, baseDelay: 300, maxDelay: 2000 });
      // Takes a moment to wind down on SIGTERM, so the replacing start is mid-terminate.
      mgr.resolveBuiltinBridge = () =>
        writeFixture(
          "race",
          marker,
          `process.on("SIGTERM", () => setTimeout(() => process.exit(0), 300));\nsetInterval(() => {}, 1000);`,
        );
      try {
        await mgr.startBridge("race", 1618);
        assert.ok(await waitFor(() => spawnTimes(marker).length === 1, 5000));
        const old = mgr.bridges.get("race").child;

        const start = mgr.startBridge("race", 1618);
        await mgr.stopBridge("race");
        assert.ok(
          old.exitCode !== null || old.signalCode !== null,
          "the stop returned while the bridge it stopped was still alive",
        );
        await start;

        await delay(300);
        assert.equal(spawnTimes(marker).length, 1, "the stopped bridge was spawned anyway");
        assert.equal(mgr.isRunning("race"), false);
      } finally {
        await mgr.stopBridge("race");
      }
    });

    it("a shutdown wins over a start still terminating the bridge it replaces", async () => {
      const marker = resolve(fixtureDir, "shutdown-race-spawns.txt");
      const mgr = new BridgeManager() as AnyMgr;
      mgr.resolveBuiltinBridge = () =>
        writeFixture(
          "shutdownrace",
          marker,
          `process.on("SIGTERM", () => setTimeout(() => process.exit(0), 300));\nsetInterval(() => {}, 1000);`,
        );
      try {
        await mgr.startBridge("shutdownrace", 1618);
        assert.ok(await waitFor(() => spawnTimes(marker).length === 1, 5000));

        const start = mgr.startBridge("shutdownrace", 1618);
        await mgr.stopAll();
        await start;

        await delay(300);
        assert.equal(spawnTimes(marker).length, 1, "a bridge was spawned during shutdown");
        assert.equal(mgr.live.size, 0);
      } finally {
        mgr.shuttingDown = false;
        await mgr.stopBridge("shutdownrace");
      }
    });

    it("never arms a SIGKILL for a group its SIGTERM couldn't reach", async () => {
      const mgr = new BridgeManager() as AnyMgr;
      const child = Object.assign(new EventEmitter(), { pid: 424243 });
      const realKill = process.kill;
      const signals: string[] = [];
      process.kill = ((_pid: number, sig?: string) => {
        signals.push(String(sig));
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      }) as typeof process.kill;
      try {
        await mgr.terminate("eperm", child, 100);
        await delay(250);
      } finally {
        process.kill = realKill;
      }
      assert.deepEqual(signals, ["SIGTERM"]);
    });

    it("a stop kills a bridge an earlier daemon left running", async () => {
      const mgr = new BridgeManager() as AnyMgr;
      const pidPath = mgr.bridgePidPath("leftover");
      mkdirSync(dirname(pidPath), { recursive: true });
      writeFileSync(pidPath, "424244");
      const realKill = process.kill;
      const kills: number[] = [];
      process.kill = ((pid: number) => {
        kills.push(pid);
        return true;
      }) as typeof process.kill;
      try {
        await mgr.stopBridge("leftover");
      } finally {
        process.kill = realKill;
      }
      assert.deepEqual(kills, [-424244]);
      assert.equal(existsSync(pidPath), false);
    });

    it("disarms the SIGKILL once a terminated bridge exits", async () => {
      const marker = resolve(fixtureDir, "disarm-spawns.txt");
      const mgr = new BridgeManager() as AnyMgr;
      mgr.stopGraceMs = 300;
      mgr.resolveBuiltinBridge = () =>
        writeFixture("disarm", marker, "setInterval(() => {}, 1000);");
      const realKill = process.kill;
      const sigkills: number[] = [];
      try {
        await mgr.startBridge("disarm", 1618);
        process.kill = ((pid: number, sig?: string | number) => {
          if (sig === "SIGKILL") sigkills.push(pid);
          return realKill(pid, sig);
        }) as typeof process.kill;
        await mgr.stopBridge("disarm");
        await delay(500);
        assert.deepEqual(sigkills, [], "a group SIGKILL fired after the child had exited");
      } finally {
        process.kill = realKill;
        await mgr.stopBridge("disarm");
      }
    });

    it("leaves the PID file of a stopped child that is still alive to its exit handler", async () => {
      const marker = resolve(fixtureDir, "survivor-spawns.txt");
      const mgr = new BridgeManager() as AnyMgr;
      mgr.stopGraceMs = 200;
      mgr.resolveBuiltinBridge = () =>
        writeFixture("survivor", marker, "setInterval(() => {}, 1000);");
      const realKill = process.kill;
      let child: AnyMgr;
      try {
        await mgr.startBridge("survivor", 1618);
        child = mgr.bridges.get("survivor").child;
        const pidPath = mgr.bridgePidPath("survivor");
        // Every signal goes astray, so the child outlives the stop.
        process.kill = (() => true) as typeof process.kill;
        await mgr.stopBridge("survivor");
        process.kill = realKill;
        assert.equal(existsSync(pidPath), true, "removed the PID file of a live child");

        process.kill(-child.pid, "SIGKILL");
        assert.ok(await waitFor(() => !existsSync(pidPath), 5000), "its exit left the PID file");
      } finally {
        process.kill = realKill;
        if (child && child.exitCode === null && child.signalCode === null) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        }
      }
    });

    describe("killOrphanBridge", () => {
      const realKill = process.kill;
      after(() => {
        process.kill = realKill;
      });

      async function orphanLogs(kill: (pid: number) => void): Promise<string[]> {
        const mgr = new BridgeManager() as AnyMgr;
        const pidPath = mgr.bridgePidPath("orphan");
        mkdirSync(dirname(pidPath), { recursive: true });
        writeFileSync(pidPath, "424242");
        const from = capturedLogs.length;
        process.kill = ((pid: number) => {
          kill(pid);
          return true;
        }) as typeof process.kill;
        try {
          mgr.killOrphanBridge("orphan");
        } finally {
          process.kill = realKill;
        }
        assert.equal(existsSync(pidPath), false);
        return capturedLogs.slice(from).map((l) => JSON.parse(l).msg as string);
      }

      const errno = (code: string) => Object.assign(new Error(code), { code });

      it("leaves alone a PID file naming a child of ours still alive", async () => {
        const mgr = new BridgeManager() as AnyMgr;
        mgr.live.set({ pid: 424242 }, "orphan");
        const pidPath = mgr.bridgePidPath("orphan");
        mkdirSync(dirname(pidPath), { recursive: true });
        writeFileSync(pidPath, "424242");
        const kills: number[] = [];
        process.kill = ((pid: number) => {
          kills.push(pid);
          return true;
        }) as typeof process.kill;
        try {
          mgr.killOrphanBridge("orphan");
        } finally {
          process.kill = realKill;
        }
        assert.deepEqual(kills, []);
        rmSync(pidPath, { force: true });
      });

      it("is silent when the process is already gone (ESRCH)", async () => {
        const logs = await orphanLogs(() => {
          throw errno("ESRCH");
        });
        assert.deepEqual(logs, []);
      });

      it("warns that an orphan may still be running when the kill is refused (EPERM)", async () => {
        const logs = await orphanLogs(() => {
          throw errno("EPERM");
        });
        assert.deepEqual(logs, [
          "could not kill orphan bridge orphan (pid 424242) — it may still be running",
        ]);
      });

      it("reports a kill that landed", async () => {
        const logs = await orphanLogs(() => {});
        assert.deepEqual(logs, ["killed orphan bridge orphan (pid 424242)"]);
      });
    });
  });

  describe("MindManager", () => {
    // The crash handler imports its lazy module graph before it counts the crash; cold,
    // that outlasts the 500ms these tests wait (#1289).
    before(warmDeliveryPath);

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

    // #1060: crash recovery is registered only once the health probe passes, so a
    // restart that dies during its own startup is consumed by `_startMind` and
    // rejects the recovery timer's `startMind` call. That rejection used to be the
    // end of the chain — "attempt 2/5" in the log, then "failed to restart", then
    // nothing, with the mind stopped and its DB `running` flag still set.
    it("keeps the recovery chain going when the restart itself dies during startup", async () => {
      const mgr = new MindManager() as AnyMgr;
      const baseDelay = 100;
      mgr.restartTracker = new RestartTracker({ maxAttempts: 3, baseDelay, maxDelay: 2000 });
      const startTimes: number[] = [];
      mgr.startMind = async (name: string) => {
        startTimes.push(Date.now());
        throw new MindStartupError(`Mind ${name} exited with code 1 during startup`, "");
      };

      const child = fakeChild();
      mgr.minds.set("chain", { child, port: 4997 });
      mgr.setupCrashRecovery("chain", child);

      const from = capturedLogs.length;
      child.emit("exit", 137);

      const msgs = () => capturedLogs.slice(from).map((l) => JSON.parse(l).msg as string);
      const gaveUp = await waitFor(
        () => msgs().includes("chain crashed 3 times — giving up on restart"),
        15000,
      );
      assert.ok(gaveUp, `the chain never reached give-up; got: ${msgs().join(" | ")}`);

      assert.equal(startTimes.length, 3, "every budgeted attempt must be tried");
      assert.deepEqual(
        msgs()
          .filter((m) => m.startsWith("crash recovery for chain"))
          .map((m) => m.split(" — ")[1]),
        [
          "attempt 1/3, restarting in 100ms",
          "attempt 2/3, restarting in 200ms",
          "attempt 3/3, restarting in 400ms",
        ],
      );
      const gaps = startTimes.slice(1).map((t, i) => t - startTimes[i]);
      assert.ok(gaps[0] >= 190, `second backoff did not grow: ${gaps[0]}ms`);
      assert.ok(gaps[1] >= 390, `third backoff did not grow: ${gaps[1]}ms`);

      assert.equal(mgr.restartTracker.getAttempts("chain"), 3);
      assert.ok(mgr.hasExhaustedRestarts("chain"), "give-up must be visible as exhausted");

      // And it stays given up: no further attempts.
      await delay(baseDelay * 8 + 100);
      assert.equal(startTimes.length, 3);

      mgr.shuttingDown = true;
    });

    for (const [label, makeError] of [
      [
        "the mind is already running",
        (name: string, mgr: AnyMgr) => {
          // As `_startMind` finds it: an operator's start got there first.
          mgr.minds.set(name, { child: fakeChild(), port: 4996 });
          return new Error(`Mind ${name} is already running`);
        },
      ],
      ["the daemon is shutting down", (name: string) => new DaemonShuttingDownError(name)],
    ] as const) {
      it(`does not spend an attempt when the restart finds ${label}`, async () => {
        const mgr = new MindManager() as AnyMgr;
        const baseDelay = 100;
        mgr.restartTracker = new RestartTracker({ maxAttempts: 3, baseDelay, maxDelay: 2000 });
        let starts = 0;
        mgr.startMind = async (name: string) => {
          starts++;
          throw makeError(name, mgr);
        };

        const child = fakeChild();
        mgr.minds.set("busy", { child, port: 4996 });
        mgr.setupCrashRecovery("busy", child);

        const from = capturedLogs.length;
        child.emit("exit", 1);

        const msgs = () => capturedLogs.slice(from).map((l) => JSON.parse(l).msg as string);
        assert.ok(
          await waitFor(() => msgs().includes("failed to restart busy"), 5000),
          "the recovery timer never fired",
        );
        // Past the next backoff, so a spuriously scheduled attempt would have fired.
        await delay(baseDelay * 2 + 200);

        assert.equal(starts, 1, "a non-startup rejection must not schedule another attempt");
        assert.equal(mgr.restartTracker.getAttempts("busy"), 1, "only the real crash counts");
        assert.deepEqual(
          msgs().filter((m) => m.startsWith("crash recovery for busy")),
          ["crash recovery for busy — attempt 1/3, restarting in 100ms"],
        );
        assert.equal(mgr.hasPendingRecovery("busy"), false, "nor retry it as strain");

        mgr.shuttingDown = true;
      });
    }

    /** A registered mind marked running, so tests can see what a stop does to the flag. */
    async function runningMind(name: string, port: number): Promise<void> {
      await addMind(name, port);
      await setMindRunning(name, true);
    }

    // #1070: a mind waiting out its backoff is not in the tracked map, so a stop
    // used to return early — leaving the timer to restart it, and `running` set.
    it("an operator stop during the backoff cancels the pending restart", async () => {
      await runningMind("halted", 4995);
      const mgr = new MindManager() as AnyMgr;
      const baseDelay = 300;
      mgr.restartTracker = new RestartTracker({ maxAttempts: 3, baseDelay, maxDelay: 2000 });
      let starts = 0;
      mgr.startMind = async () => {
        starts++;
      };

      const child = fakeChild();
      mgr.minds.set("halted", { child, port: 4995 });
      mgr.setupCrashRecovery("halted", child);
      child.emit("exit", 1);
      assert.ok(
        await waitFor(() => mgr.hasPendingRecovery("halted"), 5000),
        "the crash never scheduled a restart",
      );

      assert.equal(mgr.isRunning("halted"), false);
      assert.equal(mgr.isUpOrRecovering("halted"), true, "a mind in backoff is coming back");

      await mgr.stopMind("halted");

      assert.equal(mgr.hasPendingRecovery("halted"), false);
      assert.equal(mgr.isUpOrRecovering("halted"), false, "a stopped mind is not coming back");
      assert.equal(mgr.restartTracker.getAttempts("halted"), 0, "a stop clears the budget");
      assert.equal((await findMind("halted"))?.running, false, "a stop clears `running`");

      // Past the backoff, so a surviving timer would have fired.
      await delay(baseDelay * 2);
      assert.equal(starts, 0, "the stop must win over the pending restart");

      mgr.shuttingDown = true;
    });

    it("resumeRecovery puts a mind stopped mid-backoff back into recovery (#1114)", async () => {
      await runningMind("resumed", 4985);
      const mgr = new MindManager() as AnyMgr;
      const baseDelay = 300;
      mgr.restartTracker = new RestartTracker({ maxAttempts: 3, baseDelay, maxDelay: 2000 });
      let starts = 0;
      mgr.startMind = async () => {
        starts++;
      };

      const child = fakeChild();
      mgr.minds.set("resumed", { child, port: 4996 });
      mgr.setupCrashRecovery("resumed", child);
      child.emit("exit", 1);
      assert.ok(await waitFor(() => mgr.hasPendingRecovery("resumed"), 5000));

      // A caller (an upgrade) stops it, which cancels the recovery, then fails its start.
      await mgr.stopMind("resumed");
      assert.equal((await findMind("resumed"))?.running, false);

      await mgr.resumeRecovery("resumed");
      assert.equal(mgr.hasPendingRecovery("resumed"), true, "back in recovery");
      assert.equal((await findMind("resumed"))?.running, true);
      assert.ok(await waitFor(() => starts === 1, 5000), "the resumed recovery restarts it");

      mgr.shuttingDown = true;
    });

    // #1279: an upgrade holds recovery while its merge and npm install leave the
    // tree half-written, so a backoff that ends inside that window doesn't boot it.
    it("a held recovery waits, still pending, and starts on release", async () => {
      await runningMind("held", 4984);
      const mgr = new MindManager() as AnyMgr;
      const baseDelay = 200;
      mgr.restartTracker = new RestartTracker({ maxAttempts: 3, baseDelay, maxDelay: 2000 });
      let starts = 0;
      mgr.startMind = async () => {
        starts++;
      };

      mgr.holdRecovery("held");
      const child = fakeChild();
      mgr.minds.set("held", { child, port: 4983 });
      mgr.setupCrashRecovery("held", child);
      child.emit("exit", 1);
      assert.ok(await waitFor(() => mgr.hasPendingRecovery("held"), 5000));

      // Past the backoff, so an unheld timer would have fired.
      await delay(baseDelay * 3);
      assert.equal(starts, 0, "no boot while held");
      assert.equal(mgr.hasPendingRecovery("held"), true, "still coming back");

      mgr.releaseRecovery("held");
      assert.ok(await waitFor(() => starts === 1, 5000), "released, it starts");

      mgr.shuttingDown = true;
    });

    it("taking the hold waits out a recovery start already in flight", async () => {
      await runningMind("draining", 4980);
      const mgr = new MindManager() as AnyMgr;
      mgr.restartTracker = new RestartTracker({ maxAttempts: 3, baseDelay: 50, maxDelay: 100 });
      let started = false;
      let booted = false;
      // The real recovery path, into the real startMind; only the boot itself is stubbed.
      mgr._startMind = async () => {
        started = true;
        await delay(300);
        booted = true;
      };
      const child = fakeChild();
      mgr.minds.set("draining", { child, port: 4979 });
      mgr.setupCrashRecovery("draining", child);
      child.emit("exit", 1);
      // The recovery start got past the hold check before the hold was taken.
      assert.ok(await waitFor(() => started, 5000));

      await mgr.holdRecovery("draining");
      assert.equal(booted, true, "the merge must not begin under a boot in progress");
      mgr.releaseRecovery("draining");
      mgr.shuttingDown = true;
    });

    // #1302: a skill install and an upgrade can hold the same mind at once; whichever
    // finishes first must not lift the other's hold.
    it("an overlapping hold stays held until its own release", async () => {
      await runningMind("held-twice", 4978);
      const mgr = new MindManager() as AnyMgr;
      const baseDelay = 200;
      mgr.restartTracker = new RestartTracker({ maxAttempts: 3, baseDelay, maxDelay: 2000 });
      let starts = 0;
      mgr.startMind = async () => {
        starts++;
      };

      await mgr.holdRecovery("held-twice");
      await mgr.holdRecovery("held-twice");
      const child = fakeChild();
      mgr.minds.set("held-twice", { child, port: 4977 });
      mgr.setupCrashRecovery("held-twice", child);
      child.emit("exit", 1);
      assert.ok(await waitFor(() => mgr.hasPendingRecovery("held-twice"), 5000));
      await delay(baseDelay * 3);

      mgr.releaseRecovery("held-twice");
      await delay(baseDelay * 2);
      assert.equal(starts, 0, "still held by the other holder");
      assert.equal(mgr.hasPendingRecovery("held-twice"), true);

      mgr.releaseRecovery("held-twice");
      assert.ok(await waitFor(() => starts === 1, 5000), "the last release starts it");

      mgr.shuttingDown = true;
    });

    it("a held recovery the upgrade's own stop cancelled stays cancelled on release", async () => {
      await runningMind("held-stopped", 4982);
      const mgr = new MindManager() as AnyMgr;
      const baseDelay = 200;
      mgr.restartTracker = new RestartTracker({ maxAttempts: 3, baseDelay, maxDelay: 2000 });
      let starts = 0;
      mgr.startMind = async () => {
        starts++;
      };

      mgr.holdRecovery("held-stopped");
      const child = fakeChild();
      mgr.minds.set("held-stopped", { child, port: 4981 });
      mgr.setupCrashRecovery("held-stopped", child);
      child.emit("exit", 1);
      assert.ok(await waitFor(() => mgr.hasPendingRecovery("held-stopped"), 5000));
      await delay(baseDelay * 3);

      await mgr.stopMind("held-stopped");
      mgr.releaseRecovery("held-stopped");
      await delay(baseDelay * 2);
      assert.equal(starts, 0);
      assert.equal(mgr.hasPendingRecovery("held-stopped"), false);

      mgr.shuttingDown = true;
    });

    // #1069: a restart that fails outside the mind's own startup (a raw spawn
    // error, a registry read) is the daemon under strain, not a broken mind.
    it("retries a restart that failed outside startup without spending the budget", async () => {
      await runningMind("strained", 4994);
      const mgr = new MindManager() as AnyMgr;
      mgr.restartTracker = new RestartTracker({ maxAttempts: 3, baseDelay: 100, maxDelay: 2000 });
      mgr.strainRetryDelayMs = 150;
      const startTimes: number[] = [];
      mgr.startMind = async () => {
        startTimes.push(Date.now());
        // Two strained attempts, then one that comes up.
        if (startTimes.length <= 2) {
          throw Object.assign(new Error("spawn EMFILE"), { code: "EMFILE" });
        }
      };

      const child = fakeChild();
      mgr.minds.set("strained", { child, port: 4994 });
      mgr.setupCrashRecovery("strained", child);

      const from = capturedLogs.length;
      child.emit("exit", 1);

      assert.ok(
        await waitFor(() => startTimes.length === 3, 5000),
        `the chain stopped after ${startTimes.length} start(s)`,
      );
      const gaps = startTimes.slice(1).map((t, i) => t - startTimes[i]);
      assert.ok(
        gaps.every((g) => g >= 140),
        `retries came too fast: ${gaps.join(", ")}ms`,
      );

      assert.equal(mgr.restartTracker.getAttempts("strained"), 1, "only the real crash counts");
      assert.equal((await findMind("strained"))?.running, true, "`running` must be left alone");
      const msgs = capturedLogs.slice(from).map((l) => JSON.parse(l).msg as string);
      assert.deepEqual(
        msgs.filter((m) => m.startsWith("crash recovery for strained")),
        ["crash recovery for strained — attempt 1/3, restarting in 100ms"],
      );
      assert.equal(
        msgs.filter((m) => m.startsWith("restart of strained failed outside its startup")).length,
        2,
      );

      // The one that came up ends the chain.
      await delay(400);
      assert.equal(startTimes.length, 3);
      assert.equal(mgr.hasPendingRecovery("strained"), false);

      mgr.shuttingDown = true;
    });

    it("an operator stop cancels a pending strain retry", async () => {
      await runningMind("unstrained", 4993);
      const mgr = new MindManager() as AnyMgr;
      mgr.restartTracker = new RestartTracker({ maxAttempts: 3, baseDelay: 100, maxDelay: 2000 });
      mgr.strainRetryDelayMs = 300;
      let starts = 0;
      mgr.startMind = async () => {
        starts++;
        throw Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN" });
      };

      const child = fakeChild();
      mgr.minds.set("unstrained", { child, port: 4993 });
      mgr.setupCrashRecovery("unstrained", child);
      child.emit("exit", 1);
      assert.ok(
        await waitFor(() => starts === 1 && mgr.hasPendingRecovery("unstrained"), 5000),
        "the strain retry was never scheduled",
      );

      await mgr.stopMind("unstrained");
      assert.equal(mgr.hasPendingRecovery("unstrained"), false);
      assert.equal((await findMind("unstrained"))?.running, false);

      await delay(600);
      assert.equal(starts, 1, "the stop must win over the strain retry");

      mgr.shuttingDown = true;
    });

    it("an operator stop while the recovery start is in flight still wins", async () => {
      await runningMind("inflight", 4991);
      const mgr = new MindManager() as AnyMgr;
      mgr.restartTracker = new RestartTracker({ maxAttempts: 3, baseDelay: 100, maxDelay: 2000 });
      mgr.strainRetryDelayMs = 150;
      let starts = 0;
      let release!: () => void;
      // The real startMind's lock, so the stop queues behind the start as it would.
      mgr._startMind = async () => {
        starts++;
        await new Promise<void>((r) => {
          release = r;
        });
        throw Object.assign(new Error("spawn EMFILE"), { code: "EMFILE" });
      };

      const child = fakeChild();
      mgr.minds.set("inflight", { child, port: 4991 });
      mgr.setupCrashRecovery("inflight", child);
      child.emit("exit", 1);
      assert.ok(await waitFor(() => starts === 1, 5000), "the recovery start never began");
      // Neither tracked nor waiting on a timer — but still coming back.
      assert.equal(mgr.isRunning("inflight"), false);
      assert.equal(mgr.hasPendingRecovery("inflight"), true);

      const stopped = mgr.stopMind("inflight");
      release();
      await stopped;

      assert.equal(mgr.hasPendingRecovery("inflight"), false);
      assert.equal((await findMind("inflight"))?.running, false);
      await delay(400);
      assert.equal(
        starts,
        1,
        "the strain retry the failed start scheduled must not survive the stop",
      );

      mgr.shuttingDown = true;
    });

    it("ends the chain when there is no longer a mind to start", async () => {
      const mgr = new MindManager() as AnyMgr;
      mgr.restartTracker = new RestartTracker({ maxAttempts: 3, baseDelay: 100, maxDelay: 2000 });
      mgr.strainRetryDelayMs = 100;
      let starts = 0;
      mgr.startMind = async (name: string) => {
        starts++;
        throw new MindUnavailableError(`Unknown mind: ${name}`);
      };

      const child = fakeChild();
      mgr.minds.set("vanished", { child, port: 4990 });
      mgr.setupCrashRecovery("vanished", child);
      child.emit("exit", 1);

      assert.ok(await waitFor(() => starts === 1, 5000), "the recovery timer never fired");
      await delay(400);
      assert.equal(starts, 1, "waiting will not bring a deleted mind back");
      assert.equal(mgr.hasPendingRecovery("vanished"), false);

      mgr.shuttingDown = true;
    });

    it("does not restart a mind that was put to sleep during its backoff", async () => {
      const { getSleepManagerIfReady, initSleepManager } = await import(
        "../packages/daemon/src/lib/daemon/sleep-manager.js"
      );
      const sleepMgr = (getSleepManagerIfReady() ?? initSleepManager()) as AnyMgr;
      const mgr = new MindManager() as AnyMgr;
      const baseDelay = 200;
      mgr.restartTracker = new RestartTracker({ maxAttempts: 3, baseDelay, maxDelay: 2000 });
      let starts = 0;
      mgr.startMind = async () => {
        starts++;
      };

      const child = fakeChild();
      mgr.minds.set("drowsy", { child, port: 4988 });
      mgr.setupCrashRecovery("drowsy", child);
      child.emit("exit", 1);
      assert.ok(await waitFor(() => mgr.hasPendingRecovery("drowsy"), 5000));

      // What initiateSleep does to a mind that is not running.
      sleepMgr.states.set("drowsy", { ...sleepMgr.getState("drowsy"), sleeping: true });
      try {
        await delay(baseDelay * 3);
        assert.equal(starts, 0, "the sleep manager owns a sleeping mind's process");
        assert.equal(mgr.hasPendingRecovery("drowsy"), false);
      } finally {
        sleepMgr.states.delete("drowsy");
        mgr.shuttingDown = true;
      }
    });

    it("daemon shutdown cancels a pending restart but leaves `running` for the next boot", async () => {
      await runningMind("paused", 4992);
      const mgr = new MindManager() as AnyMgr;
      const baseDelay = 300;
      mgr.restartTracker = new RestartTracker({ maxAttempts: 3, baseDelay, maxDelay: 2000 });
      let starts = 0;
      mgr.startMind = async () => {
        starts++;
      };

      const child = fakeChild();
      mgr.minds.set("paused", { child, port: 4992 });
      mgr.setupCrashRecovery("paused", child);
      child.emit("exit", 1);
      assert.ok(await waitFor(() => mgr.hasPendingRecovery("paused"), 5000));

      await mgr.stopAll();
      assert.equal(mgr.hasPendingRecovery("paused"), false);
      assert.equal((await findMind("paused"))?.running, true);

      await delay(baseDelay * 2);
      assert.equal(starts, 0);
    });
  });
});
