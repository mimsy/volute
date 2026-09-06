import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DaemonShuttingDownError,
  MindManager,
} from "../packages/daemon/src/lib/daemon/mind-manager.js";
import {
  addMind,
  findMind,
  mindDir,
  removeMind,
  setMindRunning,
} from "../packages/daemon/src/lib/mind/registry.js";

/**
 * `startMind` had no idea a shutdown was underway, so a mind that registered after
 * `stopAll()` read the running set survived the daemon as an orphan — its own
 * process group, `detached: true`, still writing under VOLUTE_HOME (#1048).
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIND = "shutdown-guard-mind";
const PORT = 4977;

// A mind server that only has to bind its port and stay up: the guard under test
// fires long before anything real would happen. It kills itself after a minute so
// a regression in the guard leaves a slow test, never a permanent orphan.
const FIXTURE_SERVER = `import { createServer } from "node:http";

const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ name: ${JSON.stringify(MIND)} }));
}).listen(port, "127.0.0.1");

setTimeout(() => process.exit(0), 60_000);
`;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Record every child the manager tracks. "Nothing is left running" has to be
 * asserted against the real processes: the manager's own map is emptied by the
 * teardown either way, and an unbound port only means the orphan hasn't finished
 * booting yet.
 */
function trackSpawns(mgr: any): { pid?: number }[] {
  const spawned: { pid?: number }[] = [];
  const minds: Map<string, { child: { pid?: number } }> = mgr.minds;
  const set = minds.set.bind(minds);
  minds.set = (name, tracked) => {
    spawned.push(tracked.child);
    return set(name, tracked);
  };
  return spawned;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await delay(100);
  }
  return false;
}

describe("mind-manager start guard during shutdown (#1048)", () => {
  before(async () => {
    // wrapForSandbox would need a runtime the daemon initializes at boot; this
    // test drives the manager directly.
    process.env.VOLUTE_SANDBOX = "0";
    const dir = mindDir(MIND);
    mkdirSync(resolve(dir, "src"), { recursive: true });
    writeFileSync(resolve(dir, "src", "server.ts"), FIXTURE_SERVER);
    // The manager spawns `node --import tsx src/server.ts`, and node resolves the
    // bare `tsx` specifier from the spawn cwd. Symlink (never copy or install)
    // the repo's tree so the fixture can find it.
    const link = resolve(dir, "node_modules");
    if (!existsSync(link)) symlinkSync(resolve(repoRoot, "node_modules"), link, "dir");
    await addMind(MIND, PORT);
  });

  after(async () => {
    await removeMind(MIND);
    // rm unlinks the node_modules symlink rather than following it.
    rmSync(mindDir(MIND), { recursive: true, force: true });
  });

  it("refuses a start once stopAll() has begun, without spawning anything", async () => {
    const mgr = new MindManager();
    const spawned = trackSpawns(mgr);
    await mgr.stopAll();

    await assert.rejects(
      mgr.startMind(MIND, { healthTimeoutMs: 5000 }),
      (err: unknown) => err instanceof DaemonShuttingDownError,
    );
    assert.deepEqual(mgr.getRunningMinds(), []);
    assert.equal(spawned.length, 0, "the refusal must come before the spawn");
  });

  it("stops a mind that registers after stopAll() read the running set", async () => {
    const mgr = new MindManager() as any;
    const spawned = trackSpawns(mgr);

    // Park the start between its pre-spawn check and the spawn itself, so
    // stopAll() takes its snapshot inside that window. This is the orphan case
    // from #1048 — the one the pre-spawn check cannot see — and the only way to
    // hit it deterministically.
    let parked = false;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const resolveTarget = mgr.resolveTarget.bind(mgr);
    mgr.resolveTarget = async (name: string) => {
      const target = await resolveTarget(name);
      parked = true;
      await gate;
      return target;
    };

    const started = mgr.startMind(MIND, { healthTimeoutMs: 20_000 });
    for (let i = 0; i < 100 && !parked; i++) await delay(10);
    assert.ok(parked, "the start should be parked before the spawn");

    const stopping = mgr.stopAll();
    assert.deepEqual(mgr.getRunningMinds(), [], "stopAll saw an empty running set");
    release();

    await assert.rejects(
      started,
      (err: unknown) => err instanceof DaemonShuttingDownError,
      "a start that lands mid-shutdown must not report success",
    );
    await stopping;

    assert.deepEqual(mgr.getRunningMinds(), [], "no mind is left tracked");
    assert.equal(spawned.length, 1, "the start did get as far as spawning a child");
    const pid = spawned[0].pid;
    assert.ok(pid, "the spawned child has a pid");
    assert.ok(
      await waitForExit(pid),
      "the spawned mind must be reaped, not left behind as an orphan process",
    );
  });
});

describe("MindManager.restartMind interrupted by shutdown (#1048)", () => {
  const RESTARTED = "shutdown-guard-restart";

  it("leaves the mind in the next boot's set when the start is refused", async () => {
    await addMind(RESTARTED, 4978);
    await setMindRunning(RESTARTED, true);
    const realKill = process.kill.bind(process);
    const mgr = new MindManager() as any;

    const child: any = new EventEmitter();
    child.pid = 999_999;
    mgr.minds.set(RESTARTED, { child, port: 4978 });
    // The fake child has no real process group; ack the stop's SIGTERM for it.
    (process as any).kill = (_pid: number, _sig?: string | number) => {
      setImmediate(() => child.emit("exit", 0));
      return true;
    };

    // Shutdown lands in the gap the restart opens: the stop has already written
    // `running: false`, and the start that would write it back is refused.
    const stopMind = mgr._stopMind.bind(mgr);
    mgr._stopMind = async (name: string) => {
      await stopMind(name);
      await mgr.stopAll();
    };

    try {
      await assert.rejects(
        mgr.restartMind(RESTARTED),
        (err: unknown) => err instanceof DaemonShuttingDownError,
      );
      const entry = await findMind(RESTARTED);
      assert.equal(entry?.running, true, "the mind must still be booted by the next daemon");
    } finally {
      (process as any).kill = realKill;
      await removeMind(RESTARTED);
    }
  });
});
