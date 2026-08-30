import assert from "node:assert/strict";
import {
  existsSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { reapMindTmp, STALE_MIND_TMP_MS } from "../packages/daemon/src/lib/mind/tmp-reaper.js";

describe("reapMindTmp", () => {
  let root: string;
  let tmpDir: string;

  before(() => {
    root = mkdtempSync(resolve(tmpdir(), "mind-tmp-reaper-"));
    tmpDir = resolve(root, "mind", ".mind", "tmp");
    mkdirSync(tmpDir, { recursive: true });
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function backdate(path: string, ageMs: number): void {
    const when = (Date.now() - ageMs) / 1000;
    utimesSync(path, when, when);
  }

  /**
   * A scratch dir in the mind's tmp, aged by `ageMs` — contents included, which
   * is what an abandoned run actually looks like. Backdating only the directory
   * would model a dir nobody has added to while something writes inside it, and
   * that one is deliberately spared.
   */
  function makeScratch(name: string, ageMs: number): string {
    const dir = resolve(tmpDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "volute.db"), "x"); // non-empty, like a real run
    backdate(resolve(dir, "volute.db"), ageMs);
    backdate(dir, ageMs);
    return dir;
  }

  it("removes stale scratch but spares a live sibling's fresh dir", async () => {
    const stale = makeScratch("volute-test-1001", 3 * 60 * 60 * 1000); // 3h old
    const live = makeScratch("volute-test-1002", 60 * 1000); // a run in progress

    const removed = await reapMindTmp(tmpDir, STALE_MIND_TMP_MS);

    assert.deepEqual(removed, [stale]);
    assert.ok(!existsSync(stale), "scratch left by a killed run should be reaped");
    assert.ok(existsSync(live), "a concurrently-running sibling's dir must be preserved");
    rmSync(live, { recursive: true, force: true });
  });

  it("reaps whatever is stale, not just test scratch — the dir has no other janitor", async () => {
    // tsx and node leave these behind too; nothing else ever clears them.
    const tsxDir = makeScratch("tsx-501", 25 * 60 * 60 * 1000);
    const cache = makeScratch("node-compile-cache", 25 * 60 * 60 * 1000);

    const removed = await reapMindTmp(tmpDir, STALE_MIND_TMP_MS);

    assert.deepEqual(removed.sort(), [cache, tsxDir].sort());
    assert.ok(!existsSync(tsxDir));
    assert.ok(!existsSync(cache));
  });

  it("judges a symlink by the link, not by what it points at", async () => {
    // The reaper runs as the daemon (root on system installs) over content a
    // mind controls, so a planted link must be judged as a link. The
    // discriminating case is a *fresh* link aimed at an *old* directory
    // elsewhere: stat() reads the target's age and acts on it; lstat() sees a
    // fresh link and leaves it alone.
    const outsider = resolve(root, "other-mind-files");
    mkdirSync(outsider, { recursive: true });
    writeFileSync(resolve(outsider, "SOUL.md"), "# not yours\n");
    backdate(outsider, 25 * 60 * 60 * 1000);

    const fresh = resolve(tmpDir, "fresh-link");
    symlinkSync(outsider, fresh);

    // And a link left behind long ago is collected as a link: the link goes,
    // whatever it pointed at stays.
    const stale = resolve(tmpDir, "stale-link");
    symlinkSync(outsider, stale);
    const when = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
    lutimesSync(stale, when, when);

    const removed = await reapMindTmp(tmpDir, STALE_MIND_TMP_MS);

    assert.deepEqual(removed, [stale], "only the stale link is collected");
    assert.ok(existsSync(fresh), "a fresh link must not be reaped for its target's age");
    assert.ok(existsSync(resolve(outsider, "SOUL.md")), "the target's contents must be untouched");
    rmSync(fresh, { force: true });
  });

  it("spares a dir whose contents are fresh even when the dir itself looks idle", async () => {
    // A directory's mtime does not move when a file inside it is written, so a
    // script appending to TMPDIR/work/log for hours leaves work/ looking idle.
    const work = makeScratch("work", 3 * 60 * 60 * 1000);
    writeFileSync(resolve(work, "log"), "still being written");
    // Creating `log` bumped work's own mtime; push it back so the dir looks idle
    // while its contents do not. That is the state a long append leaves behind.
    backdate(work, 3 * 60 * 60 * 1000);

    assert.deepEqual(await reapMindTmp(tmpDir, STALE_MIND_TMP_MS), []);
    assert.ok(existsSync(work), "live scratch must survive a dir mtime that never moved");
    rmSync(work, { recursive: true, force: true });
  });

  it("refuses a tmp dir that is a symlink, instead of deleting through it", async () => {
    // The attack this closes: the mind owns .mind/, so it can replace .mind/tmp
    // with a link to /minds and have the daemon — root, on a system install —
    // recursively delete every other mind's directory on its behalf.
    const victim = resolve(root, "other-minds");
    mkdirSync(resolve(victim, "someone-else"), { recursive: true });
    writeFileSync(resolve(victim, "someone-else", "SOUL.md"), "# not yours\n");
    // Everything backdated, so nothing but the tmp-dir guard stands in the way:
    // if the reaper walks through the link, these are eligible and they go.
    backdate(resolve(victim, "someone-else", "SOUL.md"), 25 * 60 * 60 * 1000);
    backdate(resolve(victim, "someone-else"), 25 * 60 * 60 * 1000);
    backdate(victim, 25 * 60 * 60 * 1000);

    const linked = resolve(root, "linked-tmp");
    symlinkSync(victim, linked);

    assert.deepEqual(await reapMindTmp(linked, STALE_MIND_TMP_MS), []);
    assert.ok(
      existsSync(resolve(victim, "someone-else", "SOUL.md")),
      "a symlinked tmp dir must not become a delete primitive aimed elsewhere",
    );
  });

  it("returns an empty list for a missing tmp dir without throwing", async () => {
    assert.deepEqual(await reapMindTmp(resolve(root, "does-not-exist")), []);
  });
});
