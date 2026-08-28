import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPendingContextMessage } from "../packages/daemon/src/lib/daemon/mind-manager.js";
import {
  type InstallAndRestartDeps,
  installDepsAndRestart,
} from "../packages/daemon/src/lib/mind/upgrade.js";

/**
 * The post-merge tail of an upgrade: install the merged dependencies, then restart
 * the mind onto the new source (#973).
 *
 * Three things these pin, each of which was once broken:
 *
 * 1. A failed `npm install` used to return early, skipping the restart — leaving the
 *    old process running against new source with the template hash already advanced,
 *    so nothing would ever come back and finish the job.
 * 2. The mind's copy of the failure must ride the *pending context*, not its own
 *    event. An event POSTed before `stopMind` lands on the process about to be
 *    killed and is marked delivered, which takes it out of the set start-up replay
 *    draws from — success was the losing path.
 * 3. A restart failure has to publish its own host-facing row. `setupCrashRecovery`
 *    registers only after the health probe passes, and `autoUpgradeOne` drops the
 *    returned warning on an `upgraded` outcome, so nothing else reports it.
 */

const MIND = "test-mind";
const DIR = "/tmp/does-not-need-to-exist";
const REF = "abc123";

type Ctx = Record<string, unknown>;

function fakeManager() {
  const calls: string[] = [];
  const contexts: Ctx[] = [];
  return {
    calls,
    contexts,
    isRunning: () => true,
    stopMind: async () => {
      calls.push("stop");
    },
    startMind: async () => {
      calls.push("start");
    },
    setPendingContext: (_name: string, context: Ctx) => {
      calls.push("context");
      contexts.push(context);
    },
  };
}

type HostError = { summary: string; kind: string };

type Harness = {
  deps: InstallAndRestartDeps;
  manager: ReturnType<typeof fakeManager>;
  installs: string[];
  hostErrors: HostError[];
};

function harness(over: Partial<InstallAndRestartDeps> = {}): Harness {
  const manager = fakeManager();
  const installs: string[] = [];
  const hostErrors: HostError[] = [];
  const deps: InstallAndRestartDeps = {
    installNeeded: async () => true,
    install: async (dir) => {
      installs.push(dir);
    },
    publishHostError: async (_mind, summary, kind) => {
      hostErrors.push({ summary, kind });
    },
    getManager: () => manager,
    ...over,
  };
  return { deps, manager, installs, hostErrors };
}

const installFailure = Object.assign(new Error("Command failed: npm install"), {
  stderr:
    "npm error code ETARGET\nnpm error notarget No matching version found for @biomejs/biome@2.5.10.",
});

const failingInstall = { install: async () => Promise.reject(installFailure) };

/** The `depsFailure` text handed to setPendingContext, or undefined if there was none. */
function depsFailureOf(h: Harness): string | undefined {
  const ctx = h.manager.contexts.at(-1);
  return ctx?.depsFailure as string | undefined;
}

describe("installDepsAndRestart", () => {
  it("installs and restarts cleanly with no warning", async () => {
    const h = harness();
    const warning = await installDepsAndRestart(MIND, DIR, REF, true, h.deps);
    assert.equal(warning, undefined);
    assert.deepEqual(h.installs, [DIR]);
    assert.deepEqual(h.hostErrors, []);
    assert.deepEqual(h.manager.calls, ["stop", "context", "start"]);
    assert.deepEqual(h.manager.contexts, [{ type: "upgraded" }]);
  });

  it("skips the install when the merge left dependencies untouched", async () => {
    const h = harness({ installNeeded: async () => false });
    const warning = await installDepsAndRestart(MIND, DIR, REF, true, h.deps);
    assert.equal(warning, undefined);
    assert.deepEqual(h.installs, []);
    assert.deepEqual(h.hostErrors, []);
    assert.ok(h.manager.calls.includes("start"));
  });

  it("still restarts the mind when the install fails", async () => {
    const h = harness(failingInstall);
    const warning = await installDepsAndRestart(MIND, DIR, REF, true, h.deps);
    assert.ok(
      h.manager.calls.includes("start"),
      "a failed install must not strand the mind on its pre-upgrade process",
    );
    assert.match(String(warning), /npm install failed/);
  });

  it("carries the failure to the mind in the pending context, not as its own event", async () => {
    const h = harness(failingInstall);
    await installDepsAndRestart(MIND, DIR, REF, true, h.deps);
    const text = depsFailureOf(h);
    assert.ok(text, "the mind's copy must ride the context delivered after a healthy start");
    assert.match(text, /ETARGET/, "the npm output itself is what makes this fixable");
    assert.match(text, new RegExp(`volute mind restart ${MIND}`));
    assert.match(text, new RegExp(DIR));
    // Tense-neutral: the same text is delivered after a forced restart and at the
    // mind's next manual start, so it must not claim a restart already happened.
    assert.doesNotMatch(text, /have been restarted/);
  });

  it("sets the context before starting, so a healthy start delivers it", async () => {
    const h = harness(failingInstall);
    await installDepsAndRestart(MIND, DIR, REF, true, h.deps);
    assert.deepEqual(h.manager.calls, ["stop", "context", "start"]);
  });

  it("tells the host immediately, without waiting for the restart", async () => {
    const h = harness(failingInstall);
    await installDepsAndRestart(MIND, DIR, REF, true, h.deps);
    assert.equal(h.hostErrors.length, 1);
    assert.equal(h.hostErrors[0].kind, "upgrade_deps_failed");
    assert.match(h.hostErrors[0].summary, new RegExp(MIND));
  });

  it("still records the failure when no restart was requested", async () => {
    const h = harness(failingInstall);
    const warning = await installDepsAndRestart(MIND, DIR, REF, false, h.deps);
    assert.equal(h.hostErrors.length, 1);
    assert.ok(depsFailureOf(h), "the context waits on disk for the mind's next start");
    assert.match(String(warning), /npm install failed/);
    assert.deepEqual(h.manager.calls, ["context"], "restart was not requested");
  });
});

describe("installDepsAndRestart restart failures", () => {
  const brokenStart = (manager: ReturnType<typeof fakeManager>) => ({
    ...manager,
    startMind: async () => {
      throw new Error("port 4100 already in use");
    },
  });

  it("publishes a host-facing error when the restart fails", async () => {
    const manager = fakeManager();
    const h = harness({ getManager: () => brokenStart(manager) });
    const warning = await installDepsAndRestart(MIND, DIR, REF, true, h.deps);
    assert.equal(h.hostErrors.length, 1, "nothing else reports a mind that failed to come back up");
    assert.equal(h.hostErrors[0].kind, "upgrade_restart_failed");
    assert.match(h.hostErrors[0].summary, /the mind is down/);
    assert.match(String(warning), /restart failed: port 4100 already in use/);
    assert.doesNotMatch(String(warning), /npm install failed/);
  });

  it("reports both failures when the install and the restart each fail", async () => {
    const manager = fakeManager();
    const h = harness({
      ...failingInstall,
      getManager: () => brokenStart(manager),
    });
    const warning = await installDepsAndRestart(MIND, DIR, REF, true, h.deps);
    assert.deepEqual(
      h.hostErrors.map((e) => e.kind),
      ["upgrade_deps_failed", "upgrade_restart_failed"],
    );
    // Neither failure hides the other in the CLI/API warning.
    assert.match(String(warning), /npm install failed/);
    assert.match(String(warning), /restart failed/);
  });
});

describe("installDepsAndRestart warning text", () => {
  it("clips npm's output to one line in the warning but sends it whole to the mind", async () => {
    const noisy = Object.assign(new Error("Command failed"), {
      stderr:
        "npm error code ETARGET\nnpm error notarget No matching version found.\nnpm error A complete log of this run can be found in: /home/mind/.npm/_logs/x.log",
    });
    const h = harness({
      install: async () => Promise.reject(noisy),
    });
    const warning = String(await installDepsAndRestart(MIND, DIR, REF, true, h.deps));
    assert.match(warning, /ETARGET/);
    assert.doesNotMatch(warning, /_logs/, "the warning is a pointer, not the whole npm log");
    assert.match(
      String(depsFailureOf(h)),
      /_logs/,
      "the mind gets the full output — it's what makes it fixable",
    );
  });
});

describe("buildPendingContextMessage with a dependency failure", () => {
  it("appends the failure to the upgrade message the mind reads on start", async () => {
    const plain = await buildPendingContextMessage(MIND, { type: "upgraded" });
    const withFailure = await buildPendingContextMessage(MIND, {
      type: "upgraded",
      depsFailure: "npm error code ETARGET — run npm install.",
    });
    assert.ok(withFailure.startsWith(plain), "the ordinary upgrade message still leads");
    assert.match(withFailure, /ETARGET/);
  });

  it("leaves the upgrade message untouched when the install succeeded", async () => {
    const plain = await buildPendingContextMessage(MIND, { type: "upgraded" });
    assert.doesNotMatch(plain, /ETARGET/);
  });
});
