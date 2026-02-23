import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Scheduler } from "../src/lib/scheduler.js";

type DeliveryPayload = {
  content: { type: string; text: string }[];
  channel: string;
  sender: string;
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

  protected override async deliver(mindName: string, payload: DeliveryPayload): Promise<void> {
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
    });
    assert.equal(scheduler.scriptCalls.length, 0);
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
});
