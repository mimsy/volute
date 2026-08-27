import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  type AutoUpgradeBlocked,
  type AutoUpgradeOneDeps,
  autoUpgradeOne,
  failureDetail,
  getUpgradeBlocked,
  pruneAutoUpgradeState,
  pruneBlocked,
  resetAutoUpgradeState,
  type SelectEligibleDeps,
  selectEligible,
  UPGRADE_ALERT_KIND,
  upgradeFailureText,
} from "../packages/daemon/src/lib/daemon/auto-upgrade.js";
import type { MindEntry } from "../packages/daemon/src/lib/mind/registry.js";
import { formatNotification } from "../packages/daemon/src/lib/version-notify.js";

function makeEntry(overrides: Partial<MindEntry> & { name: string }): MindEntry {
  return {
    port: 4100,
    created: new Date().toISOString(),
    running: false,
    mindType: "mind",
    ...overrides,
  };
}

function makeDeps(opts: {
  stale?: Set<string>;
  sleeping?: Set<string>;
  manual?: Set<string>;
}): SelectEligibleDeps {
  return {
    isStale: (entry: MindEntry) => opts.stale?.has(entry.name) ?? true,
    isSleeping: (name: string) => opts.sleeping?.has(name) ?? false,
    readConfig: (name: string) => (opts.manual?.has(name) ? { upgrades: "manual" as const } : null),
  };
}

describe("selectEligible", () => {
  it("excludes spirits, seeds, and variants", () => {
    const entries = [
      makeEntry({ name: "spirit-1", mindType: "spirit" }),
      makeEntry({ name: "seed-1", stage: "seed" }),
      makeEntry({ name: "variant-1", parent: "parent-mind" }),
      makeEntry({ name: "regular-1" }),
    ];
    const result = selectEligible(entries, makeDeps({}));
    assert.deepEqual(
      result.map((e) => e.name),
      ["regular-1"],
    );
  });

  it("excludes non-stale minds", () => {
    const entries = [makeEntry({ name: "a" }), makeEntry({ name: "b" })];
    const result = selectEligible(entries, makeDeps({ stale: new Set(["a"]) }));
    assert.deepEqual(
      result.map((e) => e.name),
      ["a"],
    );
  });

  it('excludes minds opted out via "upgrades": "manual"', () => {
    const entries = [makeEntry({ name: "a" }), makeEntry({ name: "b" })];
    const result = selectEligible(entries, makeDeps({ manual: new Set(["b"]) }));
    assert.deepEqual(
      result.map((e) => e.name),
      ["a"],
    );
  });

  it("includes minds with absent config (auto is the default)", () => {
    const entries = [makeEntry({ name: "a" })];
    const result = selectEligible(entries, makeDeps({}));
    assert.deepEqual(
      result.map((e) => e.name),
      ["a"],
    );
  });

  it("includes minds explicitly configured as auto", () => {
    const entries = [makeEntry({ name: "a" })];
    const deps: SelectEligibleDeps = {
      isStale: () => true,
      isSleeping: () => false,
      readConfig: () => ({ upgrades: "auto" }),
    };
    const result = selectEligible(entries, deps);
    assert.deepEqual(
      result.map((e) => e.name),
      ["a"],
    );
  });

  it("orders sleeping minds first, preserving relative order otherwise", () => {
    const entries = [
      makeEntry({ name: "a" }),
      makeEntry({ name: "b" }),
      makeEntry({ name: "c" }),
      makeEntry({ name: "d" }),
    ];
    const result = selectEligible(entries, makeDeps({ sleeping: new Set(["b", "d"]) }));
    assert.deepEqual(
      result.map((e) => e.name),
      ["b", "d", "a", "c"],
    );
  });

  it("returns an empty array when nothing is eligible", () => {
    const entries = [makeEntry({ name: "a", stage: "seed" })];
    const result = selectEligible(entries, makeDeps({}));
    assert.deepEqual(result, []);
  });
});

describe("pruneBlocked", () => {
  function makeBlocked(reason = "merge conflicts: SOUL.md"): AutoUpgradeBlocked {
    return { reason, at: new Date() };
  }

  it("removes entries for minds not in the eligible set", () => {
    const blocked = new Map<string, AutoUpgradeBlocked>([
      ["resolved-manually", makeBlocked()],
      ["opted-out", makeBlocked()],
      ["still-blocked", makeBlocked()],
    ]);
    pruneBlocked(blocked, new Set(["still-blocked"]));
    assert.deepEqual([...blocked.keys()], ["still-blocked"]);
  });

  it("leaves entries for minds that are eligible untouched", () => {
    const entry = makeBlocked("upgrade already in progress");
    const blocked = new Map<string, AutoUpgradeBlocked>([["a", entry]]);
    pruneBlocked(blocked, new Set(["a", "b"]));
    assert.equal(blocked.get("a"), entry);
  });

  it("clears everything when nothing is eligible", () => {
    const blocked = new Map<string, AutoUpgradeBlocked>([
      ["a", makeBlocked()],
      ["b", makeBlocked()],
    ]);
    pruneBlocked(blocked, new Set());
    assert.equal(blocked.size, 0);
  });

  it("is a no-op on an empty blocked map", () => {
    const blocked = new Map<string, AutoUpgradeBlocked>();
    pruneBlocked(blocked, new Set(["a"]));
    assert.equal(blocked.size, 0);
  });
});

type Alert = { name: string; kind: string; text: string };

/** Deps that record every alert, with per-test overrides. */
function makeUpgradeDeps(
  alerts: Alert[],
  overrides: Partial<AutoUpgradeOneDeps> = {},
): AutoUpgradeOneDeps {
  return {
    isRunning: () => false,
    runUpgrade: async () => ({ status: "upgraded" }),
    abortUpgrade: async () => {},
    alertHost: async (name, kind, text) => {
      alerts.push({ name, kind, text });
    },
    delay: async () => {},
    ...overrides,
  };
}

describe("autoUpgradeOne", () => {
  beforeEach(() => {
    resetAutoUpgradeState();
  });

  it("conflicts: aborts the upgrade, alerts with the conflicting files, and records a blocked reason", async () => {
    const entry = makeEntry({ name: "conflict-mind" });
    const alerts: Alert[] = [];
    let abortedName: string | undefined;
    const deps = makeUpgradeDeps(alerts, {
      isRunning: () => true,
      runUpgrade: async () => ({
        status: "conflicts",
        worktreeDir: "/tmp/x",
        files: ["SOUL.md", "package.json"],
      }),
      abortUpgrade: async (name) => {
        abortedName = name;
      },
    });

    await autoUpgradeOne(entry, false, deps);

    assert.equal(abortedName, "conflict-mind");
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].name, "conflict-mind");
    assert.equal(alerts[0].kind, UPGRADE_ALERT_KIND);
    assert.match(alerts[0].text, /SOUL\.md/);
    assert.match(alerts[0].text, /package\.json/);
    const blocked = getUpgradeBlocked("conflict-mind");
    assert.ok(blocked, "should record a blocked entry");
    assert.match(blocked!.reason, /merge conflicts/);
  });

  it("thrown error: retries exactly once, then alerts the mind with the failing command's stderr", async () => {
    const entry = makeEntry({ name: "retry-mind" });
    const alerts: Alert[] = [];
    let attempts = 0;
    let delayMs: number | undefined;
    const deps = makeUpgradeDeps(alerts, {
      runUpgrade: async () => {
        attempts++;
        const err = new Error("Command failed: git commit") as Error & { stderr?: string };
        err.stderr = "wall: MEMORY.md is 41k over the load line — refusing this commit";
        throw err;
      },
      delay: async (ms) => {
        delayMs = ms;
      },
    });

    await autoUpgradeOne(entry, false, deps);

    assert.equal(attempts, 2, "should retry exactly once (two total attempts)");
    assert.ok(delayMs && delayMs > 0, "should delay before the retry");
    assert.equal(alerts.length, 1, "the mind must be told its framework stopped upgrading");
    assert.equal(alerts[0].kind, UPGRADE_ALERT_KIND);
    assert.match(
      alerts[0].text,
      /refusing this commit/,
      "the alert must carry the failing command's own stderr",
    );
    const blocked = getUpgradeBlocked("retry-mind");
    assert.ok(blocked, "should record a blocked entry");
    assert.match(blocked!.reason, /Command failed: git commit/);
  });

  it("does not attempt again after a failure, and does not re-alert", async () => {
    const entry = makeEntry({ name: "quiet-mind" });
    const alerts: Alert[] = [];
    let attempts = 0;
    const deps = makeUpgradeDeps(alerts, {
      runUpgrade: async () => {
        attempts++;
        throw new Error("hook refused");
      },
    });

    await autoUpgradeOne(entry, false, deps);
    await autoUpgradeOne(entry, false, deps);
    await autoUpgradeOne(entry, false, deps);

    assert.equal(attempts, 2, "only the first pass attempts (once, plus its single retry)");
    assert.equal(alerts.length, 1, "a repeated hourly pass must not re-alert");
  });

  it("re-alerts when the failure reason changes", async () => {
    const entry = makeEntry({ name: "changing-mind" });
    const alerts: Alert[] = [];
    let reason = "hook refused";
    const deps = makeUpgradeDeps(alerts, {
      runUpgrade: async () => {
        throw new Error(reason);
      },
    });

    await autoUpgradeOne(entry, false, deps);
    // A host resolved the mind out of the eligible set (a manual upgrade), clearing
    // the attempt gate; it goes stale again and fails differently.
    pruneAutoUpgradeState(new Set<string>());
    reason = "npm install failed";
    await autoUpgradeOne(entry, false, deps);

    assert.equal(alerts.length, 2, "a different failure is news, and must be alerted");
    assert.match(alerts[0].text, /hook refused/);
    assert.match(alerts[1].text, /npm install failed/);
  });

  it("re-alerts after the mind leaves the eligible set, even for the same reason", async () => {
    // Leaving the eligible set means it was upgraded by hand (or opted out) — the
    // old failure is over. Staying silent about the next one because the reason
    // string matches would leave a mind quietly broken again after someone fixed it.
    const entry = makeEntry({ name: "recovering-mind" });
    const alerts: Alert[] = [];
    const deps = makeUpgradeDeps(alerts, {
      runUpgrade: async () => {
        throw new Error("hook refused");
      },
    });

    await autoUpgradeOne(entry, false, deps);
    assert.equal(alerts.length, 1);

    pruneAutoUpgradeState(new Set<string>());
    await autoUpgradeOne(entry, false, deps);
    assert.equal(alerts.length, 2, "a fix that didn't hold must be said out loud again");
  });

  it("a clean upgrade resets the alert record, so a later failure alerts again", async () => {
    const entry = makeEntry({ name: "clean-then-broken" });
    const alerts: Alert[] = [];
    let mode: "fail" | "ok" = "ok";
    const deps = makeUpgradeDeps(alerts, {
      runUpgrade: async () => {
        if (mode === "fail") throw new Error("hook refused");
        return { status: "upgraded" };
      },
    });

    mode = "fail";
    await autoUpgradeOne(entry, false, deps);
    assert.equal(alerts.length, 1);

    // Upgrades cleanly (clearing the gate and the alert record), then breaks the
    // same way later.
    pruneAutoUpgradeState(new Set<string>());
    mode = "ok";
    await autoUpgradeOne(entry, false, deps);
    mode = "fail";
    await autoUpgradeOne(entry, false, deps);
    assert.equal(alerts.length, 2, "a failure after a clean upgrade is a new failure");
  });

  it("sleeping mind: never restarts it, even if it was running", async () => {
    const entry = makeEntry({ name: "sleeping-mind" });
    const alerts: Alert[] = [];
    let restartArg: boolean | undefined;
    const deps = makeUpgradeDeps(alerts, {
      isRunning: () => true, // wasRunning
      runUpgrade: async (_name, opts) => {
        restartArg = opts.restart;
        return { status: "upgraded" };
      },
    });

    await autoUpgradeOne(entry, /* sleeping */ true, deps);

    assert.equal(restartArg, false, "a sleeping mind must never be restarted");
  });
});

describe("failureDetail", () => {
  it("prefers the failing command's stderr", () => {
    const err = new Error("Command failed") as Error & { stderr?: string };
    err.stderr = "  pre-commit refused\n";
    assert.equal(failureDetail(err), "pre-commit refused");
  });

  it("falls back to the error message when there is no stderr", () => {
    assert.equal(failureDetail(new Error("boom")), "boom");
  });
});

describe("upgradeFailureText", () => {
  it("includes the detail and a command the mind can run itself", () => {
    const text = upgradeFailureText("mimsy", "wall: refusing this commit");
    assert.match(text, /wall: refusing this commit/);
    assert.match(text, /volute mind upgrade mimsy/);
    assert.match(text, /paused until this upgrade succeeds or the daemon restarts/);
    assert.match(text, /runs immediately/, "must not claim the mind has to wait for a restart");
  });
});

describe("formatNotification (auto-upgrade wording)", () => {
  it("points to the manual upgrade command when the mind opted out", () => {
    const message = formatNotification("1.2.3", null, true, "mymind", false);
    assert.match(message, /volute mind upgrade mymind/);
    assert.doesNotMatch(message, /applied automatically/);
  });

  it("mentions automatic upgrade when the mind has not opted out", () => {
    const message = formatNotification("1.2.3", null, true, "mymind", true);
    assert.match(message, /applied automatically/);
    assert.match(message, /"upgrades": "manual"/);
    assert.doesNotMatch(message, /volute mind upgrade mymind/);
  });

  it("omits the upgrade hint entirely when no upgrade is needed", () => {
    const message = formatNotification("1.2.3", null, false, "mymind", true);
    assert.doesNotMatch(message, /template update/);
  });
});
