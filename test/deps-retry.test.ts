import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resolveTemplate } from "../packages/daemon/src/lib/ai-service.js";
import {
  depsRetryFailureText,
  resetAutoUpgradeState,
  retryDepsFor,
} from "../packages/daemon/src/lib/daemon/auto-upgrade.js";
import {
  buildPendingContextMessage,
  initMindManager,
  tryGetMindManager,
} from "../packages/daemon/src/lib/daemon/mind-manager.js";
import {
  clearDepsPending,
  type DepsRetryDeps,
  type DepsRetryOutcome,
  depsPending,
  markDepsPending,
  retryPendingDeps,
} from "../packages/daemon/src/lib/mind/deps-retry.js";
import { RegistryUnreachableError } from "../packages/daemon/src/lib/mind/npm-install.js";
import {
  addSpirit,
  type MindEntry,
  removeMind,
  stateDir,
} from "../packages/daemon/src/lib/mind/registry.js";
import {
  getSpiritModel,
  installSpiritDeps,
  spiritDir,
  syncSpiritTemplate,
} from "../packages/daemon/src/lib/mind/spirit.js";
import {
  installDepsAndRestart,
  upgradeDepsFailureText,
} from "../packages/daemon/src/lib/mind/upgrade.js";
import {
  composeTemplate,
  findTemplatesRoot,
  renderComposedPackageJson,
} from "../packages/daemon/src/lib/template/template.js";

/**
 * A failed post-upgrade install used to be final: the template hash is advanced before
 * the install runs, so the mind no longer reads as stale and nothing came back for it —
 * not the hourly pass, not a daemon restart, not the spirit's every-start sync (bardo,
 * Nov 2026: an install run with the network down left two minds and the spirit on the
 * old SDK, and the minds were told "No matching version found").
 */

const MIND = "deps-retry-mind";
const DIR = "/tmp/deps-retry-does-not-need-to-exist";

type Ctx = Record<string, unknown>;

function fakeManager(running: boolean) {
  const calls: string[] = [];
  const contexts: Ctx[] = [];
  return {
    calls,
    contexts,
    isRunning: () => running,
    isUpOrRecovering: () => running,
    hasPendingRecovery: () => false,
    resumeRecovery: async () => {
      calls.push("resume");
    },
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

function harness(over: Partial<DepsRetryDeps> & { running?: boolean } = {}) {
  const manager = fakeManager(over.running ?? true);
  const installs: string[] = [];
  const commits: string[] = [];
  const notices: string[] = [];
  const hostErrors: string[] = [];
  const deps: DepsRetryDeps = {
    satisfied: async () => false,
    reachable: async () => true,
    install: async (dir) => {
      installs.push(dir);
    },
    commitDeps: async (_dir, _name, message) => {
      commits.push(message);
      return true;
    },
    getManager: () => manager,
    publishHostError: async (_name, _summary, kind) => {
      hostErrors.push(kind);
    },
    isAsleep: () => false,
    serverStartedAt: () => 1000,
    installedAt: () => 2000,
    readPendingContext: () => null,
    notify: async (_name, text) => {
      notices.push(text);
    },
    ...over,
  };
  return { deps, manager, installs, commits, notices, hostErrors };
}

describe("the pending-deps record", () => {
  afterEach(() => clearDepsPending(MIND));

  it("survives as a file under the mind's state dir until cleared", () => {
    assert.equal(depsPending(MIND), false);
    markDepsPending(MIND);
    assert.equal(depsPending(MIND), true);
    clearDepsPending(MIND);
    assert.equal(depsPending(MIND), false);
  });

  it("is written by a failed post-merge install and removed by a successful one", async () => {
    const manager = {
      ...fakeManager(true),
      hasPendingRecovery: () => false,
      resumeRecovery: async () => {},
    };
    const base = {
      installNeeded: async () => true,
      commitDeps: async () => true,
      publishHostError: async () => {},
      getManager: () => manager,
      isAsleep: () => false,
    };
    const failure = Object.assign(new Error("npm"), { stderr: "npm error code ETARGET" });
    await installDepsAndRestart(MIND, DIR, "ref", true, {
      ...base,
      install: async () => Promise.reject(failure),
    });
    assert.equal(depsPending(MIND), true, "the failure must outlive the daemon run");
    await installDepsAndRestart(MIND, DIR, "ref", true, { ...base, install: async () => {} });
    assert.equal(depsPending(MIND), false);
  });
});

describe("retryPendingDeps", () => {
  beforeEach(() => markDepsPending(MIND));
  afterEach(() => clearDepsPending(MIND));

  it("does nothing for a mind with no pending install", async () => {
    clearDepsPending(MIND);
    const h = harness();
    assert.equal(await retryPendingDeps(MIND, DIR, { install: true }, h.deps), "none");
    assert.deepEqual(h.installs, []);
  });

  it("installs, commits, clears the record and restarts a running mind onto the packages", async () => {
    const h = harness();
    assert.equal(await retryPendingDeps(MIND, DIR, { install: true }, h.deps), "installed");
    assert.deepEqual(h.installs, [DIR]);
    assert.equal(h.commits.length, 1, "lockfile changes are committed, as after an upgrade");
    assert.equal(depsPending(MIND), false);
    assert.deepEqual(h.manager.calls, ["stop", "context", "start"]);
    const message = await buildPendingContextMessage(MIND, h.manager.contexts[0]);
    assert.match(message, /installed now/, "the mind hears it is resolved, on the new process");
  });

  it("leaves a mind that falls asleep down for its wake (#1309)", async () => {
    const h = harness({ isAsleep: () => true });
    await retryPendingDeps(MIND, DIR, { install: true }, h.deps);
    assert.deepEqual(h.manager.calls, ["stop", "context"]);
  });

  // The record is gone by the time the restart runs, so nothing would come back: a mind
  // that doesn't come up has to be said out loud, and a cancelled recovery resumed.
  it("reports a restart that fails, and hands a recovering mind back to recovery", async () => {
    const h = harness();
    const manager = {
      ...h.manager,
      hasPendingRecovery: () => true,
      startMind: async () => {
        throw new Error("health check timed out");
      },
    };
    const outcome = await retryPendingDeps(
      MIND,
      DIR,
      { install: true },
      {
        ...h.deps,
        getManager: () => manager,
      },
    );
    assert.equal(outcome, "installed");
    assert.deepEqual(h.hostErrors, ["upgrade_restart_failed"]);
    assert.deepEqual(h.manager.calls, ["stop", "context", "resume"]);
  });

  it("tells a stopped mind instead of starting it", async () => {
    const h = harness({ running: false });
    await retryPendingDeps(MIND, DIR, { install: true }, h.deps);
    assert.deepEqual(h.manager.calls, []);
    assert.equal(h.notices.length, 1);
    assert.match(h.notices[0], /next start/);
  });

  it("takes an unheard failure out of the pending context rather than reporting its fix", async () => {
    const h = harness({
      running: false,
      readPendingContext: () => ({ type: "upgraded", depsFailure: "ETARGET" }),
    });
    await retryPendingDeps(MIND, DIR, { install: true }, h.deps);
    assert.deepEqual(h.manager.contexts, [{ type: "upgraded" }]);
    assert.deepEqual(h.notices, []);
  });

  it("does not install while the registry is unreachable, and keeps the record", async () => {
    const h = harness({ reachable: async () => false });
    assert.equal(await retryPendingDeps(MIND, DIR, { install: true }, h.deps), "unreachable");
    assert.deepEqual(h.installs, []);
    assert.equal(depsPending(MIND), true);
  });

  it("holds the install when told to, and keeps the record", async () => {
    const h = harness();
    assert.equal(await retryPendingDeps(MIND, DIR, { install: false }, h.deps), "held");
    assert.deepEqual(h.installs, []);
    assert.equal(depsPending(MIND), true);
  });

  it("returns a failed install for the caller to report, keeping the record", async () => {
    const boom = new Error("EACCES");
    const h = harness({ install: async () => Promise.reject(boom) });
    const outcome = await retryPendingDeps(MIND, DIR, { install: true }, h.deps);
    assert.deepEqual(outcome, { failed: boom });
    assert.equal(depsPending(MIND), true);
    assert.deepEqual(h.manager.calls, [], "no restart onto packages that aren't there");
  });

  describe("when someone else already installed them", () => {
    it("clears the record without installing or restarting", async () => {
      const h = harness({ satisfied: async () => true, serverStartedAt: () => 3000 });
      // `install: false` too: the check must run even while installs are held.
      assert.equal(await retryPendingDeps(MIND, DIR, { install: false }, h.deps), "satisfied");
      assert.deepEqual(h.installs, []);
      assert.deepEqual(h.manager.calls, []);
      assert.deepEqual(h.notices, [], "the mind restarted after its install; nothing to say");
      assert.equal(depsPending(MIND), false);
      assert.equal(h.commits.length, 1, "a hand-run install's lockfile is committed (#1385)");
    });

    // whorl, Nov 2026: ran npm install itself but never restarted, so it still had the
    // old SDK loaded.
    it("tells a mind whose process predates the install, without restarting it", async () => {
      const h = harness({ satisfied: async () => true });
      await retryPendingDeps(MIND, DIR, { install: true }, h.deps);
      assert.deepEqual(h.manager.calls, []);
      assert.equal(h.notices.length, 1);
      assert.match(h.notices[0], /still has the old packages loaded/);
      assert.match(h.notices[0], new RegExp(`volute mind restart ${MIND}`));
    });

    it("says nothing to a mind that isn't running", async () => {
      const h = harness({ satisfied: async () => true, running: false });
      await retryPendingDeps(MIND, DIR, { install: true }, h.deps);
      assert.deepEqual(h.notices, []);
    });
  });
});

describe("retryDepsFor (the auto-upgrade pass)", () => {
  const entry: MindEntry = {
    name: MIND,
    port: 4100,
    created: "",
    running: true,
    mindType: "mind",
    dir: DIR,
  };
  type Alert = { name: string; kind: string; text: string };

  function passDeps(outcome: DepsRetryOutcome) {
    const alerts: Alert[] = [];
    const installFlags: boolean[] = [];
    return {
      alerts,
      installFlags,
      deps: {
        retry: async (_name: string, _dir: string, opts: { install: boolean }) => {
          installFlags.push(opts.install);
          return outcome;
        },
        alertHost: async (name: string, kind: string, text: string) => {
          alerts.push({ name, kind, text });
        },
      },
    };
  }

  beforeEach(() => resetAutoUpgradeState());

  it("reports a failure that isn't the network once, then stops installing", async () => {
    const failed = Object.assign(new Error("npm"), { stderr: "npm error code EACCES" });
    const p = passDeps({ failed });
    await retryDepsFor(entry, p.deps);
    await retryDepsFor(entry, p.deps);
    assert.equal(p.alerts.length, 1, "said once, not every hour");
    assert.equal(p.alerts[0].kind, "upgrade_deps_failed");
    assert.match(p.alerts[0].text, /EACCES/);
    assert.match(p.alerts[0].text, /doesn't look like the network/);
    assert.deepEqual(p.installFlags, [true, false], "no second minutes-long install this run");
  });

  it("neither reports nor stops retrying while the network is failing", async () => {
    for (const outcome of [
      "unreachable" as const,
      { failed: new RegistryUnreachableError(new Error("ETARGET")) },
      // DNS resolved, the network still failed: mid-install drop, a 5xx, a captive portal.
      { failed: Object.assign(new Error("npm"), { stderr: "npm error code ECONNRESET" }) },
      { failed: Object.assign(new Error("npm"), { stderr: "npm error code E503" }) },
      {
        failed: Object.assign(new Error("npm"), { stderr: "npm error invalid json response body" }),
      },
    ]) {
      resetAutoUpgradeState();
      const p = passDeps(outcome);
      await retryDepsFor(entry, p.deps);
      await retryDepsFor(entry, p.deps);
      assert.deepEqual(p.alerts, []);
      assert.deepEqual(p.installFlags, [true, true]);
    }
  });

  it("names the command the mind can run", () => {
    const text = depsRetryFailureText(MIND, DIR, "npm error code EACCES");
    assert.match(text, new RegExp(`npm install\` in ${DIR}`));
    assert.doesNotMatch(text, /reachable/, "DNS resolving proves nothing about reachability");
  });
});

describe("what a mind is told about a failed install", () => {
  const etarget = Object.assign(new Error("npm"), {
    stderr: "npm error code ETARGET\nnpm error notarget No matching version found for x@1.0.0.",
  });

  it("says the registry was unreachable, not that the version is missing", () => {
    const text = upgradeDepsFailureText(MIND, DIR, new RegistryUnreachableError(etarget));
    assert.match(text, /could not be reached/);
    assert.match(text, /The packages are fine/);
    assert.match(text, /No matching version/, "npm's own output is still shown");
    assert.doesNotMatch(text, /twice/, "the registry was never asked");
  });

  it("says twice only when the registry retry ran", () => {
    assert.match(upgradeDepsFailureText(MIND, DIR, etarget), /twice/);
    const eacces = Object.assign(new Error("npm"), { stderr: "npm error code EACCES" });
    assert.doesNotMatch(upgradeDepsFailureText(MIND, DIR, eacces), /twice/);
  });

  it("no longer claims nothing retries it", () => {
    assert.doesNotMatch(upgradeDepsFailureText(MIND, DIR, etarget), /Nothing retries/);
  });
});

describe("the spirit's dependencies", () => {
  const SPIRIT = "volute";

  afterEach(async () => {
    clearDepsPending(SPIRIT);
    resetAutoUpgradeState();
    rmSync(spiritDir(), { recursive: true, force: true });
    rmSync(stateDir(SPIRIT), { recursive: true, force: true });
    await removeMind(SPIRIT).catch(() => {});
  });

  it("a failed sync install records the failure and says it once", async () => {
    const alerts: string[] = [];
    const alert = async (_n: string, kind: string) => {
      alerts.push(kind);
    };
    const fail = async () => Promise.reject(new Error("npm error code ETARGET"));
    await installSpiritDeps(DIR, SPIRIT, fail, alert);
    await installSpiritDeps(DIR, SPIRIT, fail, alert);
    assert.equal(depsPending(SPIRIT), true);
    assert.deepEqual(alerts, ["upgrade_deps_failed"]);
    await installSpiritDeps(DIR, SPIRIT, async () => {}, alert);
    assert.equal(depsPending(SPIRIT), false);
  });

  // bardo: the spirit's sync rewrites package.json before installing, so after a failed
  // install the next start saw nothing changed and never tried again.
  it("a daemon start with the record pending checks again, though package.json is unchanged", async () => {
    const dir = spiritDir();
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(resolve(dir, "home/.config"), { recursive: true });
    const template = await resolveTemplate(getSpiritModel());
    const { composedDir } = composeTemplate(findTemplatesRoot(), template);
    cpSync(resolve(composedDir, "src"), resolve(dir, "src"), { recursive: true });
    const pkgPath = renderComposedPackageJson(composedDir, SPIRIT);
    assert.ok(pkgPath);
    cpSync(pkgPath, resolve(dir, "package.json"));
    // Installed — by hand, say — so the check is a real, offline `npm ls` and no
    // install runs. npm ls --depth=0 looks only at the top level.
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    for (const [name, spec] of Object.entries({
      ...pkg.dependencies,
      ...pkg.devDependencies,
    })) {
      const at = resolve(dir, "node_modules", name);
      mkdirSync(at, { recursive: true });
      const version = String(spec).replace(/^[\^~]/, "");
      writeFileSync(resolve(at, "package.json"), JSON.stringify({ name, version }));
    }
    await addSpirit(SPIRIT, 4999, template, dir);
    markDepsPending(SPIRIT);
    if (!tryGetMindManager()) initMindManager();

    await syncSpiritTemplate();

    assert.equal(depsPending(SPIRIT), false);
    assert.equal(
      existsSync(resolve(dir, "node_modules/.package-lock.json")),
      false,
      "cleared by the offline check, not by a real install",
    );
  });
});
