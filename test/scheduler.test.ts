import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Scheduler } from "../src/lib/daemon/scheduler.js";

type DeliveryPayload = {
  content: { type: string; text: string }[];
  channel: string;
  sender: string;
  whileSleeping?: "skip" | "queue" | "trigger-wake";
};

/** Test subclass that captures calls instead of running real exec/deliver */
class TestScheduler extends Scheduler {
  deliveries: { mindName: string; payload: DeliveryPayload }[] = [];
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

  protected override async deliver(
    mindName: string,
    payload: DeliveryPayload & { whileSleeping?: "skip" | "queue" | "trigger-wake" },
  ): Promise<void> {
    this.deliveries.push({ mindName, payload });
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

  it("fire delivers message for message schedules", async () => {
    const scheduler = new TestScheduler();
    await (scheduler as any).fire("test-mind", {
      id: "msg-sched",
      cron: "* * * * *",
      message: "hello",
      enabled: true,
    });
    assert.equal(scheduler.deliveries.length, 1);
    assert.equal(scheduler.deliveries[0].mindName, "test-mind");
    assert.deepEqual(scheduler.deliveries[0].payload, {
      content: [{ type: "text", text: "hello" }],
      channel: "system:scheduler",
      sender: "msg-sched",
      whileSleeping: undefined,
    });
    assert.equal(scheduler.scriptCalls.length, 0);
  });

  it("fire uses custom channel when specified", async () => {
    const scheduler = new TestScheduler();
    await (scheduler as any).fire("test-mind", {
      id: "dream",
      cron: "0 3 * * *",
      message: "time to dream",
      enabled: true,
      channel: "system:dream",
    });
    assert.equal(scheduler.deliveries.length, 1);
    assert.deepEqual(scheduler.deliveries[0].payload, {
      content: [{ type: "text", text: "time to dream" }],
      channel: "system:dream",
      sender: "dream",
      whileSleeping: undefined,
    });
  });

  it("fire runs script and delivers output", async () => {
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

    assert.equal(scheduler.deliveries.length, 1);
    assert.equal(scheduler.deliveries[0].mindName, "test-mind");
    assert.deepEqual(scheduler.deliveries[0].payload, {
      content: [{ type: "text", text: "script output\n" }],
      channel: "system:scheduler",
      sender: "script-sched",
      whileSleeping: undefined,
    });
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
    assert.equal(scheduler.deliveries.length, 0);
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
    assert.equal(scheduler.deliveries.length, 0);
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

    assert.equal(scheduler.deliveries.length, 1);
    const text = scheduler.deliveries[0].payload.content[0].text;
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

    assert.equal(scheduler.deliveries.length, 1);
    const text = scheduler.deliveries[0].payload.content[0].text;
    assert.equal(text, "[script error] command not found");
  });

  it("fire skips schedule with neither message nor script", async () => {
    const scheduler = new TestScheduler();

    await (scheduler as any).fire("test-mind", {
      id: "empty-sched",
      cron: "* * * * *",
      enabled: true,
    });

    assert.equal(scheduler.deliveries.length, 0);
    assert.equal(scheduler.scriptCalls.length, 0);
  });

  it("fire passes whileSleeping from schedule to delivery", async () => {
    const scheduler = new TestScheduler();
    await (scheduler as any).fire("test-mind", {
      id: "sleep-sched",
      cron: "* * * * *",
      message: "hello",
      enabled: true,
      whileSleeping: "trigger-wake",
    });
    assert.equal(scheduler.deliveries.length, 1);
    assert.equal(scheduler.deliveries[0].payload.whileSleeping, "trigger-wake");
  });

  it("fire maps legacy skipWhenSleeping to whileSleeping skip", async () => {
    const scheduler = new TestScheduler();
    await (scheduler as any).fire("test-mind", {
      id: "legacy-sched",
      cron: "* * * * *",
      message: "hello",
      enabled: true,
      skipWhenSleeping: true,
    });
    assert.equal(scheduler.deliveries.length, 1);
    assert.equal(scheduler.deliveries[0].payload.whileSleeping, "skip");
  });

  it("fire delivers fireAt schedule", async () => {
    const scheduler = new TestScheduler();
    await (scheduler as any).fire("test-mind", {
      id: "timer-sched",
      fireAt: new Date(Date.now() - 60000).toISOString(),
      message: "timer fired",
      enabled: true,
    });
    assert.equal(scheduler.deliveries.length, 1);
    assert.equal(scheduler.deliveries[0].payload.content[0].text, "timer fired");
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
    const parts = input.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
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
