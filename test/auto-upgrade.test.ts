import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type AutoUpgradeBlocked,
  type AutoUpgradeOneDeps,
  autoUpgradeOne,
  getUpgradeBlocked,
  pruneBlocked,
  type SelectEligibleDeps,
  selectEligible,
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

describe("autoUpgradeOne", () => {
  it("conflicts: aborts the upgrade, notifies the mind with the conflicting files, and records a blocked reason", async () => {
    const entry = makeEntry({ name: "conflict-mind" });
    let abortedName: string | undefined;
    let deliveredBody: string | undefined;
    const deps: AutoUpgradeOneDeps = {
      isRunning: () => true,
      runUpgrade: async () => ({
        status: "conflicts",
        worktreeDir: "/tmp/x",
        files: ["SOUL.md", "package.json"],
      }),
      abortUpgrade: async (name) => {
        abortedName = name;
      },
      deliverEvent: async (_name, input) => {
        deliveredBody = input.body;
        return { delivered: true };
      },
      delay: async () => {},
    };

    await autoUpgradeOne(entry, false, deps);

    assert.equal(abortedName, "conflict-mind");
    assert.match(deliveredBody ?? "", /SOUL\.md/);
    assert.match(deliveredBody ?? "", /package\.json/);
    const blocked = getUpgradeBlocked("conflict-mind");
    assert.ok(blocked, "should record a blocked entry");
    assert.match(blocked!.reason, /merge conflicts/);
  });

  it("thrown error: retries exactly once, then records blocked and sends no event", async () => {
    const entry = makeEntry({ name: "retry-mind" });
    let attempts = 0;
    let eventSent = false;
    let delayMs: number | undefined;
    const deps: AutoUpgradeOneDeps = {
      isRunning: () => false,
      runUpgrade: async () => {
        attempts++;
        throw new Error("transient git failure");
      },
      abortUpgrade: async () => {},
      deliverEvent: async () => {
        eventSent = true;
        return { delivered: true };
      },
      delay: async (ms) => {
        delayMs = ms;
      },
    };

    await autoUpgradeOne(entry, false, deps);

    assert.equal(attempts, 2, "should retry exactly once (two total attempts)");
    assert.equal(eventSent, false, "transient errors should not notify the mind");
    assert.ok(delayMs && delayMs > 0, "should delay before the retry");
    const blocked = getUpgradeBlocked("retry-mind");
    assert.ok(blocked, "should record a blocked entry");
    assert.match(blocked!.reason, /transient git failure/);
  });

  it("sleeping mind: never restarts it, even if it was running", async () => {
    const entry = makeEntry({ name: "sleeping-mind" });
    let restartArg: boolean | undefined;
    const deps: AutoUpgradeOneDeps = {
      isRunning: () => true, // wasRunning
      runUpgrade: async (_name, opts) => {
        restartArg = opts.restart;
        return { status: "upgraded" };
      },
      abortUpgrade: async () => {},
      deliverEvent: async () => ({ delivered: true }),
      delay: async () => {},
    };

    await autoUpgradeOne(entry, /* sleeping */ true, deps);

    assert.equal(restartArg, false, "a sleeping mind must never be restarted");
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
