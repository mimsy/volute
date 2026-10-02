import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
  groupMembersExcept,
  terminateGroup,
} from "../packages/daemon/src/lib/util/process-group.js";

/** A fake /proc: each entry is `pid → [comm, pgrp]`. */
function fakeProc(procs: Record<number, [string, number]>): string {
  const dir = mkdtempSync(resolve(tmpdir(), "fake-proc-"));
  for (const [pid, [comm, pgrp]] of Object.entries(procs)) {
    mkdirSync(resolve(dir, pid));
    writeFileSync(resolve(dir, pid, "stat"), `${pid} (${comm}) S 1 ${pgrp} ${pgrp} 0 -1 4194560\n`);
  }
  mkdirSync(resolve(dir, "self"));
  mkdirSync(resolve(dir, "77")); // a pid that exited mid-scan: no stat
  return dir;
}

function recorder() {
  const sent: [number, string][] = [];
  return { sent, kill: (pid: number, sig: string) => void sent.push([pid, sig]) };
}

describe("groupMembersExcept", () => {
  it("lists the group's members other than the excluded pid", async () => {
    const proc = fakeProc({
      100: ["runuser", 100],
      101: ["node", 100],
      // comm can hold spaces and parens; pgrp is counted from the last ')'
      102: ["claude (sdk) 7 9", 100],
      200: ["node", 200],
    });
    assert.deepEqual((await groupMembersExcept(100, 100, proc)).sort(), [101, 102]);
  });
});

describe("terminateGroup", () => {
  it("signals the mind's processes and spares the runuser supervisor (#1364)", async () => {
    // runuser SIGKILLs its child 2s after it is itself SIGTERMed, so a stop must
    // never signal it — nor the group, which would include it.
    const proc = fakeProc({ 100: ["runuser", 100], 101: ["node", 100], 102: ["claude", 100] });
    const { sent, kill } = recorder();
    await terminateGroup(100, { spareLeader: true, procDir: proc, kill });
    assert.deepEqual(
      sent.sort((a, b) => a[0] - b[0]),
      [
        [101, "SIGTERM"],
        [102, "SIGTERM"],
      ],
    );
  });

  it("signals the whole group when nothing is supervising", async () => {
    const proc = fakeProc({ 100: ["node", 100], 101: ["claude", 100] });
    const { sent, kill } = recorder();
    await terminateGroup(100, { spareLeader: false, procDir: proc, kill });
    assert.deepEqual(sent, [[-100, "SIGTERM"]]);
  });

  it("falls back to the group when only the supervisor is left", async () => {
    const proc = fakeProc({ 100: ["runuser", 100] });
    const { sent, kill } = recorder();
    await terminateGroup(100, { spareLeader: true, procDir: proc, kill });
    assert.deepEqual(sent, [[-100, "SIGTERM"]]);
  });

  it("falls back to the group when /proc can't be read", async () => {
    const { sent, kill } = recorder();
    await terminateGroup(100, { spareLeader: true, procDir: "/nonexistent-proc", kill });
    assert.deepEqual(sent, [[-100, "SIGTERM"]]);
  });

  it("rejects when the group signal finds no group", async () => {
    const kill = () => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    };
    await assert.rejects(terminateGroup(100, { spareLeader: false, kill }), /ESRCH/);
  });
});
