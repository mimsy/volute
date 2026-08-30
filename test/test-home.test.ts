import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { STALE_TEST_HOME_MS, sweepStaleTestHomes, TEST_HOME_PREFIX } from "./helpers/test-home.js";

// Above any OS's pid_max (Linux tops out at 4194304, macOS at 99998), so these
// can never name a live process and the sweep's liveness check always says gone.
const DEAD_PID_A = 9999998;
const DEAD_PID_B = 9999999;

describe("sweepStaleTestHomes", () => {
  let root: string;

  before(() => {
    root = mkdtempSync(resolve(tmpdir(), "sweep-test-"));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Create a `volute-test-<pid>` dir and backdate its mtime by `ageMs`. */
  function makeHome(pid: number, ageMs: number): string {
    const dir = resolve(root, `${TEST_HOME_PREFIX}${pid}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "volute.db"), "x"); // non-empty, like a real run
    const when = (Date.now() - ageMs) / 1000;
    utimesSync(dir, when, when);
    return dir;
  }

  it("removes stale homes older than the threshold but keeps fresh ones", () => {
    const stale = makeHome(DEAD_PID_A, 3 * 60 * 60 * 1000); // 3h old
    const fresh = makeHome(DEAD_PID_B, 60 * 1000); // 1m old

    const removed = sweepStaleTestHomes(root, 2 * 60 * 60 * 1000);

    assert.deepEqual(removed, [stale]);
    assert.ok(!existsSync(stale), "stale home should be removed");
    assert.ok(existsSync(fresh), "fresh home (a concurrent run) must be preserved");
  });

  it("spares a live sibling's home even once it is past the age threshold", () => {
    // The case age alone gets wrong: a run that hangs for hours is still a run.
    // Its pid is in the dirname, so liveness is a fact here, not an inference.
    const live = makeHome(process.pid, 5 * 60 * 60 * 1000);

    const removed = sweepStaleTestHomes(root, STALE_TEST_HOME_MS);

    assert.ok(!removed.includes(live), "a running process's home must never be swept");
    assert.ok(existsSync(live), "a hung-but-live run must keep its home");
    rmSync(live, { recursive: true, force: true });
  });

  it("ignores unrelated directories", () => {
    const unrelated = resolve(root, "some-other-dir");
    mkdirSync(unrelated, { recursive: true });
    const when = (Date.now() - 24 * 60 * 60 * 1000) / 1000; // a full day old
    utimesSync(unrelated, when, when);

    sweepStaleTestHomes(root, 2 * 60 * 60 * 1000);

    assert.ok(existsSync(unrelated), "non volute-test-* dirs are never swept");
  });

  it("returns an empty list for a missing root without throwing", () => {
    assert.deepEqual(sweepStaleTestHomes(resolve(root, "does-not-exist"), 1000), []);
  });
});

/**
 * The sweep at startup only helps a run that *starts*. A run that finishes must
 * collect a killed sibling's leftovers too, or a leaked home survives until
 * someone runs the suite again — which on a mind's machine may be never, since
 * its TMPDIR is a mind directory nothing else clears (#805).
 */
describe("test/setup.ts exit sweep", () => {
  // Same root setup.ts picks, so the child under test sweeps the dir we plant in.
  const tmpRoot = process.platform === "darwin" ? "/tmp" : tmpdir();
  // Per-process name. The suffix is deliberately not a bare pid: several agents
  // run this suite concurrently on one box, so a fixed path would let one run's
  // cleanup delete another's probe — and a bare `volute-test-<pid>` would be
  // spared by the sweep's own liveness check, since this process is alive.
  const leaked = resolve(tmpRoot, `${TEST_HOME_PREFIX}exit-probe-${process.pid}`);

  after(() => {
    rmSync(leaked, { recursive: true, force: true });
  });

  it("collects a home left by a force-killed run when a sibling exits", async () => {
    // The child plants the stale home *itself*, after setup.ts has already run —
    // so its startup sweep has been and gone, and only the exit sweep is left to
    // collect this. Planting it from here instead would prove nothing: the
    // startup sweep would take it and the test would pass either way.
    const plant =
      "import('node:fs').then((f) => {" +
      "const d = process.env.PROBE_DIR;" +
      "f.mkdirSync(d, { recursive: true });" +
      "f.writeFileSync(d + '/volute.db', 'x');" +
      `const w = (Date.now() - ${STALE_TEST_HOME_MS + 60_000}) / 1000;` +
      "f.utimesSync(d, w, w);" +
      "})";

    await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "--import", "./test/setup.ts", "-e", plant],
      {
        cwd: resolve(import.meta.dirname, ".."),
        env: { ...process.env, PROBE_DIR: leaked },
        timeout: 60_000,
      },
    );

    assert.ok(!existsSync(leaked), "a finishing run must collect a killed sibling's home");
  });
});
