import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  ensureMindUser,
  linuxUseraddArgs,
  macIdToCreate,
  parseDsclIds,
  planMindGroup,
  planUserRepair,
  repairRemedy,
} from "../packages/daemon/src/lib/mind/isolation.js";

// Repair of a mind's missing OS user. The end-to-end case (a Docker container
// recreated onto its old volumes, so /minds keeps files owned by uids that
// /etc/passwd no longer knows) needs root and a container, so what is unit
// tested here is the decision — which ids may be reused and which must not —
// plus the argv that carries it out.

const originalIsolation = process.env.VOLUTE_ISOLATION;

function reason(plan: ReturnType<typeof planUserRepair>): string {
  return plan.action === "reuse" ? "" : plan.reason;
}

describe("planUserRepair", () => {
  const base = {
    user: "mind-lyra",
    userExists: false,
    dirOwner: { uid: 996, gid: 996 },
    uidTakenBy: null,
    gidOwner: null,
    reuseGid: true,
  };

  it("does nothing when the user is still there", () => {
    assert.equal(planUserRepair({ ...base, userExists: true }).action, "none");
  });

  it("reuses the directory's uid and gid on Linux", () => {
    assert.deepEqual(planUserRepair(base), { action: "reuse", uid: 996, gid: 996 });
  });

  it("reuses only the uid when the platform owns mind dirs by a shared group", () => {
    // macOS: mind dirs are <user>:volute, so the gid is the live volute group's
    // and must not be pinned to whatever the directory happens to carry.
    const plan = planUserRepair({ ...base, reuseGid: false, gidOwner: "volute" });
    assert.deepEqual(plan, { action: "reuse", uid: 996, gid: null });
  });

  it("refuses to reuse uid 0 — a root-owned dir means the chown never ran", () => {
    const plan = planUserRepair({ ...base, dirOwner: { uid: 0, gid: 0 } });
    assert.equal(plan.action, "refuse");
    assert.match(reason(plan), /root-owned/);
  });

  it("refuses to reuse gid 0", () => {
    const plan = planUserRepair({ ...base, dirOwner: { uid: 996, gid: 0 } });
    assert.equal(plan.action, "refuse");
    assert.match(reason(plan), /root-grouped/);
  });

  it("refuses to clobber a uid that belongs to someone else", () => {
    const plan = planUserRepair({ ...base, uidTakenBy: "postgres" });
    assert.equal(plan.action, "refuse");
    assert.match(reason(plan), /996 already belongs to postgres/);
  });

  it("refuses to clobber a gid that belongs to another group", () => {
    const plan = planUserRepair({ ...base, gidOwner: "docker" });
    assert.equal(plan.action, "refuse");
    assert.match(reason(plan), /996 already belongs to group docker/);
  });

  it("reuses through its own leftover group, so a half-done repair can retry", () => {
    // A repair that created mind-lyra's group and then failed at useradd leaves
    // the group holding the gid. That is ours, not a collision.
    const plan = planUserRepair({ ...base, gidOwner: "mind-lyra" });
    assert.deepEqual(plan, { action: "reuse", uid: 996, gid: 996 });
  });

  it("refuses rather than allocating a fresh id when the mind directory is gone", () => {
    // A fresh id is not a repair: in the wipe scenario every mind's uid is free
    // in passwd while still owning files, so `useradd -r` can hand this mind the
    // uid that owns another mind's chmod-700 directory.
    const plan = planUserRepair({ ...base, dirOwner: null });
    assert.equal(plan.action, "refuse");
    assert.match(reason(plan), /missing or unreadable/);
  });

  it("never substitutes a fresh id — every non-reuse outcome refuses", () => {
    const inputs = [
      { ...base, dirOwner: null },
      { ...base, dirOwner: { uid: 0, gid: 0 } },
      { ...base, dirOwner: { uid: 996, gid: 0 } },
      { ...base, uidTakenBy: "postgres" },
      { ...base, gidOwner: "docker" },
    ];
    for (const input of inputs) {
      assert.equal(planUserRepair(input).action, "refuse");
    }
  });
});

describe("linuxUseraddArgs", () => {
  it("creates a fresh user with system defaults", () => {
    assert.deepEqual(linuxUseraddArgs("mind-lyra", "/minds/lyra/home"), [
      "-r",
      "-M",
      "-G",
      "volute",
      "-s",
      "/usr/sbin/nologin",
      "-d",
      "/minds/lyra/home",
      "mind-lyra",
    ]);
  });

  it("pins uid and gid on the repair path and keeps volute group membership", () => {
    const args = linuxUseraddArgs("mind-lyra", "/minds/lyra/home", { uid: 996, gid: 996 });
    assert.deepEqual(args.slice(0, 6), ["-r", "-M", "-G", "volute", "-s", "/usr/sbin/nologin"]);
    assert.deepEqual(args.slice(6), [
      "-u",
      "996",
      "-g",
      "996",
      "-d",
      "/minds/lyra/home",
      "mind-lyra",
    ]);
  });

  it("pins the uid alone when no gid is being reused", () => {
    const args = linuxUseraddArgs("mind-lyra", "/minds/lyra/home", { uid: 996, gid: null });
    assert.deepEqual(args.slice(6), ["-u", "996", "-d", "/minds/lyra/home", "mind-lyra"]);
    assert.equal(args.includes("-g"), false);
  });
});

describe("planMindGroup", () => {
  it("creates the group when there isn't one", () => {
    assert.equal(planMindGroup(null, 996), "create");
  });

  it("skips its own leftover group on the right gid", () => {
    assert.equal(planMindGroup(996, 996), "skip");
  });

  it("refuses a same-named group sitting on a different gid", () => {
    // groupadd -f would have exited 0 here and left useradd asking for a gid
    // that does not exist; fail with the diagnosis instead.
    assert.throws(() => planMindGroup(1001, 996), /gid 1001.*need gid 996/);
  });
});

describe("macIdToCreate", () => {
  it("allocates the first free id above 400 when nothing is pinned", () => {
    assert.equal(macIdToCreate(undefined, new Set([401, 402])), 403);
  });

  it("uses a pinned id that is free", () => {
    assert.equal(macIdToCreate(996, new Set([401])), 996);
  });

  it("refuses a pinned id that is already in use", () => {
    // macOS has no `useradd`-style uniqueness refusal — dscl would mint a
    // duplicate — so this check is the only thing standing in the way.
    assert.throws(() => macIdToCreate(996, new Set([996])), /already in use/);
  });

  it("reads ids out of dscl listing output", () => {
    const ids = parseDsclIds("mind-lyra   996\nmind-vale   997\n\n");
    assert.deepEqual([...ids].sort(), [996, 997]);
  });
});

describe("repairRemedy", () => {
  // A refusal is the only thing a host sees when a mind cannot start, so the
  // message has to carry both halves of the fix: bring the user back, and hand
  // it the files. Checked per platform — the two branches are separate strings.
  for (const platform of ["linux", "darwin"] as const) {
    it(`names both steps a host must take on ${platform}`, () => {
      const remedy = repairRemedy("mind-lyra", "/minds/lyra", platform);
      assert.match(remedy, /mind-lyra/);
      assert.match(remedy, /chown -R/);
      assert.match(remedy, /\/minds\/lyra/);
    });
  }

  it("tells a Linux host to recreate the user in the volute group", () => {
    const remedy = repairRemedy("mind-lyra", "/minds/lyra", "linux");
    assert.match(remedy, /useradd .*-G volute/);
  });
});

describe("ensureMindUser", () => {
  afterEach(() => {
    if (originalIsolation === undefined) delete process.env.VOLUTE_ISOLATION;
    else process.env.VOLUTE_ISOLATION = originalIsolation;
  });

  it("is a no-op when isolation is off", async () => {
    process.env.VOLUTE_ISOLATION = "none";
    await ensureMindUser("no-such-mind");
  });

  it("does nothing unprivileged — creating users needs root", async (t) => {
    // Skipped as root: the repair would really run and create a system user.
    // What this pins is the guard, not the catch-all: unprivileged callers must
    // return without probing or throwing, which is what keeps the existing
    // isolation tests (which assert chown's own failure) unchanged.
    if (process.getuid?.() === 0) return t.skip("needs an unprivileged process");
    process.env.VOLUTE_ISOLATION = "user";
    await ensureMindUser("no-such-mind");
  });
});
