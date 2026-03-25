import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Scheduler } from "../packages/daemon/src/lib/daemon/scheduler.js";

type SystemDelivery = {
  mindName: string;
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

  protected override async deliverSystem(
    mindName: string,
    text: string,
    opts?: { whileSleeping?: "skip" | "queue" | "trigger-wake"; session?: string },
  ): Promise<void> {
    this.systemDeliveries.push({ mindName, text, opts });
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
    assert.equal(scheduler.systemDeliveries[0].text, "[msg-sched] hello");
    assert.equal(scheduler.scriptCalls.length, 0);
  });

  it("fire passes session from schedule config", async () => {
    const scheduler = new TestScheduler();
    await (scheduler as any).fire("test-mind", {
      id: "dream",
      cron: "0 3 * * *",
      message: "time to dream",
      enabled: true,
      session: "$new",
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
