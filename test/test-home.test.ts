import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { sweepStaleTestHomes, TEST_HOME_PREFIX } from "./helpers/test-home.js";

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
    const stale = makeHome(1001, 3 * 60 * 60 * 1000); // 3h old
    const fresh = makeHome(1002, 60 * 1000); // 1m old

    const removed = sweepStaleTestHomes(root, 2 * 60 * 60 * 1000);

    assert.deepEqual(removed, [stale]);
    assert.ok(!existsSync(stale), "stale home should be removed");
    assert.ok(existsSync(fresh), "fresh home (a concurrent run) must be preserved");
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
