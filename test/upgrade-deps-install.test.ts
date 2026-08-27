import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type InstallAndRestartDeps,
  installDepsAndRestart,
} from "../packages/daemon/src/lib/mind/upgrade.js";

/**
 * The post-merge tail of an upgrade: install the merged dependencies, then restart
 * the mind onto the new source (#973).
 *
 * The bug these pin: a failed `npm install` used to return early, skipping the
 * restart. That left the mind's old process running against new source on disk with
 * the template hash already advanced — so nothing would ever come back and finish
 * the job, and the only record was a `warn` in journald. Both halves matter here:
 * the restart still happens, and the failure reaches the mind and the dashboard.
 */

const MIND = "test-mind";
const DIR = "/tmp/does-not-need-to-exist";
const REF = "abc123";

function fakeManager() {
  const calls: string[] = [];
  return {
    calls,
    isRunning: () => true,
    stopMind: async () => {
      calls.push("stop");
    },
    startMind: async () => {
      calls.push("start");
    },
    setPendingContext: () => {
      calls.push("context");
    },
  };
}

type Harness = {
  deps: InstallAndRestartDeps;
  manager: ReturnType<typeof fakeManager>;
  installs: string[];
  alerts: string[];
};

function harness(over: Partial<InstallAndRestartDeps> = {}): Harness {
  const manager = fakeManager();
  const installs: string[] = [];
  const alerts: string[] = [];
  const deps: InstallAndRestartDeps = {
    installNeeded: async () => true,
    install: async (dir) => {
      installs.push(dir);
    },
    alert: async (_mind, text) => {
      alerts.push(text);
    },
    getManager: () => manager,
    ...over,
  };
  return { deps, manager, installs, alerts };
}

const installFailure = Object.assign(new Error("Command failed: npm install"), {
  stderr:
    "npm error code ETARGET\nnpm error notarget No matching version found for @biomejs/biome@2.5.10.",
});

describe("installDepsAndRestart", () => {
  it("installs and restarts cleanly with no warning", async () => {
    const h = harness();
    const warning = await installDepsAndRestart(MIND, DIR, REF, true, h.deps);
    assert.equal(warning, undefined);
    assert.deepEqual(h.installs, [DIR]);
    assert.deepEqual(h.alerts, []);
    assert.deepEqual(h.manager.calls, ["stop", "context", "start"]);
  });

  it("skips the install when the merge left dependencies untouched", async () => {
    const h = harness({ installNeeded: async () => false });
    const warning = await installDepsAndRestart(MIND, DIR, REF, true, h.deps);
    assert.equal(warning, undefined);
    assert.deepEqual(h.installs, []);
    assert.deepEqual(h.alerts, []);
    assert.ok(h.manager.calls.includes("start"));
  });

  it("still restarts the mind when the install fails", async () => {
    const h = harness({
      install: async () => {
        throw installFailure;
      },
    });
    const warning = await installDepsAndRestart(MIND, DIR, REF, true, h.deps);
    assert.ok(
      h.manager.calls.includes("start"),
      "a failed install must not strand the mind on its pre-upgrade process",
    );
    assert.match(String(warning), /npm install failed/);
    assert.match(String(warning), /restarted/);
  });

  it("tells the mind what failed, verbatim, and what to run", async () => {
    const h = harness({
      install: async () => {
        throw installFailure;
      },
    });
    await installDepsAndRestart(MIND, DIR, REF, true, h.deps);
    assert.equal(h.alerts.length, 1);
    const alert = h.alerts[0];
    assert.match(alert, /ETARGET/, "the npm output itself is what makes this fixable");
    assert.match(alert, /npm install/);
    assert.match(alert, new RegExp(`volute mind restart ${MIND}`));
    assert.match(alert, new RegExp(DIR));
  });

  it("alerts even when no restart was requested", async () => {
    const h = harness({
      install: async () => {
        throw installFailure;
      },
    });
    const warning = await installDepsAndRestart(MIND, DIR, REF, false, h.deps);
    assert.equal(h.alerts.length, 1);
    assert.match(String(warning), /npm install failed/);
    assert.deepEqual(h.manager.calls, ["context"], "restart was not requested");
  });

  it("alerts before the restart, so a restart that fails is already explained", async () => {
    const order: string[] = [];
    const manager = fakeManager();
    const warning = await installDepsAndRestart(MIND, DIR, REF, true, {
      installNeeded: async () => true,
      install: async () => {
        throw installFailure;
      },
      alert: async () => {
        order.push("alert");
      },
      getManager: () => {
        order.push("restart");
        return {
          ...manager,
          startMind: async () => {
            throw new Error("port 4100 already in use");
          },
        };
      },
    });
    assert.deepEqual(order, ["alert", "restart"]);
    // Both failures survive into one warning — neither hides the other.
    assert.match(String(warning), /npm install failed/);
    assert.match(String(warning), /restart failed/);
  });

  it("reports a restart failure on its own when the install succeeded", async () => {
    const manager = fakeManager();
    const h = harness({
      getManager: () => ({
        ...manager,
        startMind: async () => {
          throw new Error("boom");
        },
      }),
    });
    const warning = await installDepsAndRestart(MIND, DIR, REF, true, h.deps);
    assert.match(String(warning), /restart failed: boom/);
    assert.doesNotMatch(String(warning), /npm install failed/);
  });
});

describe("installDepsAndRestart alert failures", () => {
  it("restarts anyway when the alert itself fails", async () => {
    const manager = fakeManager();
    const warning = await installDepsAndRestart(MIND, DIR, REF, true, {
      installNeeded: async () => true,
      install: async () => {
        throw installFailure;
      },
      alert: async () => {
        throw new Error("the event table is on fire");
      },
      getManager: () => manager,
    });
    assert.ok(
      manager.calls.includes("start"),
      "failing to report the problem must not become a second problem",
    );
    assert.match(String(warning), /npm install failed/);
  });
});

describe("installDepsAndRestart warning text", () => {
  it("clips npm's output to one line in the warning but sends it whole to the mind", async () => {
    const noisy = Object.assign(new Error("Command failed"), {
      stderr:
        "npm error code ETARGET\nnpm error notarget No matching version found.\nnpm error A complete log of this run can be found in: /home/mind/.npm/_logs/x.log",
    });
    const h = harness({
      install: async () => {
        throw noisy;
      },
    });
    const warning = String(await installDepsAndRestart(MIND, DIR, REF, true, h.deps));
    assert.match(warning, /ETARGET/);
    assert.doesNotMatch(warning, /_logs/, "the warning is a pointer, not the whole npm log");
    assert.match(
      h.alerts[0],
      /_logs/,
      "the mind gets the full output — it's what makes it fixable",
    );
  });
});
