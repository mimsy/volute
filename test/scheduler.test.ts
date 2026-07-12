import assert from "node:assert/strict";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { _resetConfigCache } from "../packages/daemon/src/lib/config/setup.js";
import {
  resolveMindToken,
  revokeMindToken,
} from "../packages/daemon/src/lib/daemon/mind-tokens.js";
import { Scheduler } from "../packages/daemon/src/lib/daemon/scheduler.js";
import { voluteSystemDir } from "../packages/daemon/src/lib/mind/registry.js";
import { SandboxUnavailableError } from "../packages/daemon/src/lib/mind/sandbox.js";

type SystemDelivery = {
  mindName: string;
  scheduleId: string;
  text: string;
  opts?: { whileSleeping?: "skip" | "queue" | "trigger-wake"; session?: string };
};

/** Test subclass that captures calls instead of running real exec/deliver */
class TestScheduler extends Scheduler {
  systemDeliveries: SystemDelivery[] = [];
  scriptCalls: { script: string; cwd: string; mindName: string }[] = [];
  scriptResult: string | Error = "";

  protected override async runScript(
    script: string,
    cwd: string,
    mindName: string,
  ): Promise<string> {
    this.scriptCalls.push({ script, cwd, mindName });
    if (this.scriptResult instanceof Error) throw this.scriptResult;
    return this.scriptResult;
  }

  /** Result the stubbed deliverSystem returns; tests override to simulate failures. */
  deliverResult: { id?: number; delivered: boolean } = { id: 1, delivered: true };

  protected override async deliverSystem(
    mindName: string,
    scheduleId: string,
    text: string,
    opts?: { whileSleeping?: "skip" | "queue" | "trigger-wake"; session?: string },
  ): Promise<{ id?: number; delivered: boolean }> {
    this.systemDeliveries.push({ mindName, scheduleId, text, opts });
    return this.deliverResult;
  }
}

describe("scheduler", () => {
  it("start and stop manage interval", () => {
    const scheduler = new Scheduler();
    scheduler.start();
    scheduler.stop();
    assert.ok(true);
  });

  it("unloadSchedules removes mind schedules", () => {
    const scheduler = new Scheduler();
    scheduler.unloadSchedules("nonexistent");
    assert.ok(true);
  });

  it("loadSchedules accepts explicit dir parameter", () => {
    const scheduler = new TestScheduler();
    // This will fail to read config (no file) but shouldn't throw
    scheduler.loadSchedules("test-spirit", "/tmp/nonexistent-dir");
    // unload should clear the dir cache
    scheduler.unloadSchedules("test-spirit");
    assert.ok(true);
  });

  it("fire uses cached dir for script cwd", async () => {
    const scheduler = new TestScheduler();
    scheduler.scriptResult = "output";

    // Set up dir cache by calling loadSchedules with dir
    scheduler.loadSchedules("spirit-test", "/tmp/test-spirit-dir");

    await (scheduler as any).fire("spirit-test", {
      id: "test-script",
      cron: "* * * * *",
      script: "echo hi",
      enabled: true,
    });

    assert.equal(scheduler.scriptCalls.length, 1);
    assert.equal(scheduler.scriptCalls[0].cwd, "/tmp/test-spirit-dir/home");
  });

  it("fire delivers message via system chat", async () => {
    const scheduler = new TestScheduler();
    await (scheduler as any).fire("test-mind", {
      id: "msg-sched",
      cron: "* * * * *",
      message: "hello",
      enabled: true,
    });
    assert.equal(scheduler.systemDeliveries.length, 1);
    assert.equal(scheduler.systemDeliveries[0].mindName, "test-mind");
    assert.equal(scheduler.systemDeliveries[0].scheduleId, "msg-sched");
    assert.equal(scheduler.systemDeliveries[0].text, "hello");
    assert.equal(scheduler.scriptCalls.length, 0);
  });

  it("fire picks a message from a rotating pool", async () => {
    const scheduler = new TestScheduler();
    const schedule = {
      id: "heartbeat",
      cron: "* * * * *",
      messages: ["first", "second", "third"],
      enabled: true,
    };
    const originalRandom = Math.random;
    try {
      Math.random = () => 0;
      await (scheduler as any).fire("test-mind", schedule);
      Math.random = () => 0.999;
      await (scheduler as any).fire("test-mind", schedule);
    } finally {
      Math.random = originalRandom;
    }
    assert.equal(scheduler.systemDeliveries.length, 2);
    assert.equal(scheduler.systemDeliveries[0].text, "first");
    assert.equal(scheduler.systemDeliveries[1].text, "third");
  });

  it("fire falls back to message when messages pool is empty", async () => {
    const scheduler = new TestScheduler();
    await (scheduler as any).fire("test-mind", {
      id: "hb",
      cron: "* * * * *",
      messages: [],
      message: "fallback",
      enabled: true,
    });
    assert.equal(scheduler.systemDeliveries.length, 1);
    assert.equal(scheduler.systemDeliveries[0].text, "fallback");
  });

  it("fire skips schedule with empty messages and no message or script", async () => {
    const scheduler = new TestScheduler();
    await (scheduler as any).fire("test-mind", {
      id: "hb",
      cron: "* * * * *",
      messages: [],
      enabled: true,
    });
    assert.equal(scheduler.systemDeliveries.length, 0);
  });

  it("fire skips malformed messages pools from hand-edited config", async () => {
    const scheduler = new TestScheduler();
    // Not an array — must not index into the string
    await (scheduler as any).fire("test-mind", {
      id: "hb",
      cron: "* * * * *",
      messages: "hello",
      enabled: true,
    });
    // Non-string entry — must not deliver "undefined"/"[object Object]"
    await (scheduler as any).fire("test-mind", {
      id: "hb2",
      cron: "* * * * *",
      messages: [42],
      enabled: true,
    });
    assert.equal(scheduler.systemDeliveries.length, 0);
  });

  it("fire passes session from schedule config", async () => {
    const scheduler = new TestScheduler();
    await (scheduler as any).fire("test-mind", {
      id: "dream",
      cron: "0 3 * * *",
      message: "time to dream",
      enabled: true,
      thread: "$new",
    });
    assert.equal(scheduler.systemDeliveries.length, 1);
    assert.equal(scheduler.systemDeliveries[0].opts?.session, "$new");
  });

  it("fire uses legacy channel as session fallback", async () => {
    const scheduler = new TestScheduler();
    await (scheduler as any).fire("test-mind", {
      id: "dream",
      cron: "0 3 * * *",
      message: "time to dream",
      enabled: true,
      channel: "system:dream",
    });
    // Legacy channel is ignored — no session override
    assert.equal(scheduler.systemDeliveries.length, 1);
    assert.equal(scheduler.systemDeliveries[0].opts?.session, undefined);
  });

  it("fire runs script and delivers output via system chat", async () => {
    const scheduler = new TestScheduler();
    scheduler.scriptResult = "script output\n";

    await (scheduler as any).fire("test-mind", {
      id: "script-sched",
      cron: "* * * * *",
      script: "echo hello",
      enabled: true,
    });

    assert.equal(scheduler.scriptCalls.length, 1);
    assert.equal(scheduler.scriptCalls[0].script, "echo hello");
    assert.equal(scheduler.scriptCalls[0].mindName, "test-mind");

    assert.equal(scheduler.systemDeliveries.length, 1);
    assert.equal(scheduler.systemDeliveries[0].mindName, "test-mind");
    assert.ok(scheduler.systemDeliveries[0].text.includes("script output"));
  });

  it("fire skips delivery when script produces no output", async () => {
    const scheduler = new TestScheduler();
    scheduler.scriptResult = "";

    await (scheduler as any).fire("test-mind", {
      id: "quiet-script",
      cron: "* * * * *",
      script: "true",
      enabled: true,
    });

    assert.equal(scheduler.scriptCalls.length, 1);
    assert.equal(scheduler.systemDeliveries.length, 0);
  });

  it("fire skips delivery when script produces only whitespace", async () => {
    const scheduler = new TestScheduler();
    scheduler.scriptResult = "   \n  \n";

    await (scheduler as any).fire("test-mind", {
      id: "ws-script",
      cron: "* * * * *",
      script: "echo ''",
      enabled: true,
    });

    assert.equal(scheduler.scriptCalls.length, 1);
    assert.equal(scheduler.systemDeliveries.length, 0);
  });

  it("fire delivers error when script fails", async () => {
    const scheduler = new TestScheduler();
    scheduler.scriptResult = Object.assign(new Error("exit code 1"), { stderr: "bad command" });

    await (scheduler as any).fire("test-mind", {
      id: "fail-script",
      cron: "* * * * *",
      script: "bad-cmd",
      enabled: true,
    });

    assert.equal(scheduler.systemDeliveries.length, 1);
    const text = scheduler.systemDeliveries[0].text;
    assert.ok(text.includes("[script error]"));
    assert.ok(text.includes("bad command"));
  });

  it("fire delivers error without stderr when absent", async () => {
    const scheduler = new TestScheduler();
    scheduler.scriptResult = new Error("command not found");

    await (scheduler as any).fire("test-mind", {
      id: "fail-no-stderr",
      cron: "* * * * *",
      script: "missing-cmd",
      enabled: true,
    });

    assert.equal(scheduler.systemDeliveries.length, 1);
    const text = scheduler.systemDeliveries[0].text;
    assert.ok(text.includes("[script error] command not found"));
  });

  it("fire skips schedule with neither message nor script", async () => {
    const scheduler = new TestScheduler();

    await (scheduler as any).fire("test-mind", {
      id: "empty-sched",
      cron: "* * * * *",
      enabled: true,
    });

    assert.equal(scheduler.systemDeliveries.length, 0);
    assert.equal(scheduler.scriptCalls.length, 0);
  });

  it("fire passes whileSleeping from schedule", async () => {
    const scheduler = new TestScheduler();
    await (scheduler as any).fire("test-mind", {
      id: "sleep-sched",
      cron: "* * * * *",
      message: "hello",
      enabled: true,
      whileSleeping: "trigger-wake",
    });
    assert.equal(scheduler.systemDeliveries.length, 1);
    assert.equal(scheduler.systemDeliveries[0].opts?.whileSleeping, "trigger-wake");
  });

  it("fire delivers fireAt schedule via system chat", async () => {
    const scheduler = new TestScheduler();
    await (scheduler as any).fire("test-mind", {
      id: "timer-sched",
      fireAt: new Date(Date.now() - 60000).toISOString(),
      message: "timer fired",
      enabled: true,
    });
    assert.equal(scheduler.systemDeliveries.length, 1);
    assert.ok(scheduler.systemDeliveries[0].text.includes("timer fired"));
  });

  it("fireAt self-deletes once the event row exists, even if delivery is pending", async () => {
    // An undelivered event stays pending and is redelivered on the mind's next
    // start/wake, so the one-shot's job is done once the row exists.
    const scheduler = new TestScheduler();
    const removed: string[] = [];
    (scheduler as any).removeSchedule = (_mind: string, id: string) => removed.push(id);

    scheduler.deliverResult = { id: 7, delivered: false };
    await (scheduler as any).fire("test-mind", {
      id: "pending-timer",
      fireAt: new Date(Date.now() - 60000).toISOString(),
      message: "timer",
      enabled: true,
    });
    assert.deepEqual(removed, ["pending-timer"], "schedule removed — event row is durable");
  });

  it("fireAt is retained when the event row could not be recorded at all", async () => {
    const scheduler = new TestScheduler();
    const removed: string[] = [];
    (scheduler as any).removeSchedule = (_mind: string, id: string) => removed.push(id);

    scheduler.deliverResult = { id: undefined, delivered: false };
    await (scheduler as any).fire("test-mind", {
      id: "lost-timer",
      fireAt: new Date(Date.now() - 60000).toISOString(),
      message: "timer",
      enabled: true,
    });
    assert.deepEqual(removed, [], "schedule kept so the next tick retries the insert");
  });
});

describe("scheduler runScript sandboxing", () => {
  const origSandbox = process.env.VOLUTE_SANDBOX;
  const origOptional = process.env.VOLUTE_SANDBOX_OPTIONAL;

  function configPath() {
    return resolve(voluteSystemDir(), "config.json");
  }

  afterEach(() => {
    _resetConfigCache();
    try {
      unlinkSync(configPath());
    } catch {}
    if (origSandbox === undefined) delete process.env.VOLUTE_SANDBOX;
    else process.env.VOLUTE_SANDBOX = origSandbox;
    if (origOptional === undefined) delete process.env.VOLUTE_SANDBOX_OPTIONAL;
    else process.env.VOLUTE_SANDBOX_OPTIONAL = origOptional;
  });

  it("routes scripts through the sandbox in sandbox mode (never bare bash)", async () => {
    // Enable sandbox mode with no opt-out. The sandbox runtime is not initialized
    // in unit tests, so a script that went through the sandbox path fails closed
    // instead of running bare `bash` in the daemon's trust domain.
    delete process.env.VOLUTE_SANDBOX;
    delete process.env.VOLUTE_SANDBOX_OPTIONAL;
    mkdirSync(voluteSystemDir(), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({ setup: { isolation: "sandbox" } }));
    _resetConfigCache();

    const scheduler = new Scheduler();
    await assert.rejects(
      () =>
        (
          scheduler as unknown as {
            runScript: (s: string, cwd: string, m: string) => Promise<string>;
          }
        ).runScript("echo hi", "/tmp", "alice"),
      SandboxUnavailableError,
    );
  });

  it("runs scripts directly when sandbox is disabled", async () => {
    process.env.VOLUTE_SANDBOX = "0";
    delete process.env.VOLUTE_SANDBOX_OPTIONAL;
    const scheduler = new Scheduler();
    const out = await (
      scheduler as unknown as {
        runScript: (s: string, cwd: string, m: string) => Promise<string>;
      }
    ).runScript("echo scheduled-ok", "/tmp", "alice");
    assert.ok(out.includes("scheduled-ok"));
  });

  it("runs scripts with the mind's auth env and no daemon admin token", async () => {
    process.env.VOLUTE_SANDBOX = "0";
    delete process.env.VOLUTE_SANDBOX_OPTIONAL;
    // A leaked daemon admin token would grant scripts admin privileges — it must
    // be withheld and replaced by the mind's own non-admin token.
    process.env.VOLUTE_DAEMON_TOKEN = "super-secret-admin";
    try {
      const scheduler = new Scheduler();
      const out = await (
        scheduler as unknown as {
          runScript: (s: string, cwd: string, m: string) => Promise<string>;
        }
      ).runScript(
        'printf "%s\\n%s\\n%s" "$VOLUTE_MIND" "$VOLUTE_MIND_TOKEN" "$VOLUTE_DAEMON_TOKEN"',
        "/tmp",
        "alice",
      );
      const [mind, token, admin] = out.split("\n");
      assert.equal(mind, "alice");
      assert.ok(token && token.length > 0, "script should receive a mind token");
      // The token is non-admin and scoped to this mind.
      assert.equal(resolveMindToken(token), "alice");
      // The daemon admin token is never handed to the script (expands to empty).
      assert.equal(admin, "");
    } finally {
      delete process.env.VOLUTE_DAEMON_TOKEN;
      revokeMindToken("alice");
    }
  });
});

describe("scheduler fireAt", () => {
  it("shouldFire returns true when fireAt time has passed", () => {
    const scheduler = new TestScheduler();
    const pastTime = new Date(Date.now() - 120000).toISOString();
    const epochMinute = Math.floor(Date.now() / 60000);
    const result = (scheduler as any).shouldFire(
      { id: "timer", fireAt: pastTime, enabled: true },
      epochMinute,
      "test-mind",
      new Map(),
    );
    assert.equal(result, true);
  });

  it("shouldFire returns false when fireAt time is in the future", () => {
    const scheduler = new TestScheduler();
    const futureTime = new Date(Date.now() + 300000).toISOString();
    const epochMinute = Math.floor(Date.now() / 60000);
    const result = (scheduler as any).shouldFire(
      { id: "timer", fireAt: futureTime, enabled: true },
      epochMinute,
      "test-mind",
      new Map(),
    );
    assert.equal(result, false);
  });

  it("shouldFire returns false when schedule has no cron or fireAt", () => {
    const scheduler = new TestScheduler();
    const epochMinute = Math.floor(Date.now() / 60000);
    const result = (scheduler as any).shouldFire(
      { id: "empty", enabled: true },
      epochMinute,
      "test-mind",
      new Map(),
    );
    assert.equal(result, false);
  });
});

describe("scheduler catch-up (level-triggered cron)", () => {
  const nowMin = () => Math.floor(Date.now() / 60000);
  const heartbeat = { id: "heartbeat", cron: "* * * * *", enabled: true };

  it("fires a caught-up cron once when a minute was skipped", () => {
    const scheduler = new TestScheduler();
    const epochMinute = nowMin();
    const key = "test-mind:heartbeat";
    // Last acted-on minute is 3 minutes stale (missed ticks).
    (scheduler as any).lastFired.set(key, epochMinute - 3);

    const first = (scheduler as any).shouldFire(heartbeat, epochMinute, "test-mind", new Map());
    assert.equal(first, true);
    // lastFired advances to the fired cron minute (== epochMinute for every-minute cron).
    assert.equal((scheduler as any).lastFired.get(key), epochMinute);

    // Same minute again → no double fire.
    const second = (scheduler as any).shouldFire(heartbeat, epochMinute, "test-mind", new Map());
    assert.equal(second, false);
  });

  it("does not fire when already up to date this minute", () => {
    const scheduler = new TestScheduler();
    const epochMinute = nowMin();
    (scheduler as any).lastFired.set("test-mind:heartbeat", epochMinute);
    const result = (scheduler as any).shouldFire(heartbeat, epochMinute, "test-mind", new Map());
    assert.equal(result, false);
  });

  it("skips a stale catch-up fire but still advances lastFired", () => {
    const scheduler = new TestScheduler();
    const realMin = nowMin();
    // Pretend we're evaluating 20 minutes after the cron minute (long downtime).
    const epochMinute = realMin + 20;
    const key = "test-mind:dream";
    (scheduler as any).lastFired.set(key, realMin - 30);

    const result = (scheduler as any).shouldFire(
      { id: "dream", cron: "* * * * *", enabled: true },
      epochMinute,
      "test-mind",
      new Map(),
    );
    // Too stale to deliver...
    assert.equal(result, false);
    // ...but lastFired advanced to the cron minute so it won't be retried.
    assert.equal((scheduler as any).lastFired.get(key), realMin);
  });
});

describe("scheduler loadSchedules bookkeeping", () => {
  function writeConfig(dir: string, schedules: unknown[]) {
    mkdirSync(resolve(dir, "home/.config"), { recursive: true });
    writeFileSync(resolve(dir, "home/.config/volute.json"), JSON.stringify({ schedules }));
  }

  it("baseline-inits new schedules and prunes stale keys for the mind only (#428, #453)", () => {
    const scheduler = new TestScheduler();
    const dir = resolve(voluteSystemDir(), "sched-bookkeep-mind");
    writeConfig(dir, [{ id: "heartbeat", cron: "* * * * *", message: "hi", enabled: true }]);

    const lf = (scheduler as any).lastFired as Map<string, number>;
    // Pre-seed: a stale key for this mind + a live key for another mind.
    lf.set("sched-bookkeep-mind:old-removed", 100);
    lf.set("other-mind:keepme", 200);

    scheduler.loadSchedules("sched-bookkeep-mind", dir);

    // Stale key for this mind pruned (#428).
    assert.equal(lf.has("sched-bookkeep-mind:old-removed"), false);
    // Other mind's key untouched — prune is per-mind only.
    assert.equal(lf.get("other-mind:keepme"), 200);
    // New schedule baselined to the current minute (#453) so no history replay.
    assert.equal(lf.get("sched-bookkeep-mind:heartbeat"), Math.floor(Date.now() / 60000));
  });

  it("baseline prevents an immediate replay for a freshly loaded schedule", () => {
    const scheduler = new TestScheduler();
    const dir = resolve(voluteSystemDir(), "sched-fresh-mind");
    writeConfig(dir, [{ id: "beat", cron: "* * * * *", message: "hi", enabled: true }]);

    scheduler.loadSchedules("sched-fresh-mind", dir);

    const epochMinute = Math.floor(Date.now() / 60000);
    const result = (scheduler as any).shouldFire(
      { id: "beat", cron: "* * * * *", enabled: true },
      epochMinute,
      "sched-fresh-mind",
      new Map(),
    );
    // Baseline == epochMinute, so the current-minute cron fire is not replayed.
    assert.equal(result, false);
  });
});

describe("parseDuration", () => {
  // Import dynamically since it's in clock.ts — test the regex logic directly
  function parseDuration(input: string): number | null {
    const parts = input.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    if (!parts || parts[0] !== input) return null;
    const hours = parseInt(parts[1] || "0", 10);
    const minutes = parseInt(parts[2] || "0", 10);
    const seconds = parseInt(parts[3] || "0", 10);
    const total = hours * 3600_000 + minutes * 60_000 + seconds * 1000;
    return total > 0 ? total : null;
  }

  it("parses minutes", () => {
    assert.equal(parseDuration("10m"), 600_000);
  });

  it("parses hours", () => {
    assert.equal(parseDuration("1h"), 3600_000);
  });

  it("parses seconds", () => {
    assert.equal(parseDuration("30s"), 30_000);
  });

  it("parses combined h+m", () => {
    assert.equal(parseDuration("2h30m"), 9000_000);
  });

  it("parses combined h+m+s", () => {
    assert.equal(parseDuration("1h30m15s"), 5415_000);
  });

  it("returns null for empty string", () => {
    assert.equal(parseDuration(""), null);
  });

  it("returns null for invalid input", () => {
    assert.equal(parseDuration("abc"), null);
  });

  it("returns null for zero duration", () => {
    assert.equal(parseDuration("0m"), null);
  });
});
