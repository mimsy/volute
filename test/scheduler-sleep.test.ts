import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Scheduler } from "../src/lib/daemon/scheduler.js";

type DeliveryPayload = {
  content: { type: string; text: string }[];
  channel: string;
  sender: string;
  whileSleeping?: "skip" | "queue" | "trigger-wake";
};

class TestScheduler extends Scheduler {
  deliveries: { mindName: string; payload: DeliveryPayload }[] = [];

  protected override async runScript(): Promise<string> {
    return "";
  }

  protected override async deliver(mindName: string, payload: DeliveryPayload): Promise<void> {
    this.deliveries.push({ mindName, payload });
  }
}

describe("scheduler whileSleeping", () => {
  it("delivers message with whileSleeping undefined by default", async () => {
    const scheduler = new TestScheduler();
    await (scheduler as any).fire("test-mind", {
      id: "no-flag",
      cron: "* * * * *",
      message: "hello",
      enabled: true,
    });
    assert.equal(scheduler.deliveries.length, 1);
    assert.equal(scheduler.deliveries[0].payload.whileSleeping, undefined);
  });

  it("passes whileSleeping: skip to delivery", async () => {
    const scheduler = new TestScheduler();
    await (scheduler as any).fire("test-mind", {
      id: "skip-sched",
      cron: "* * * * *",
      message: "hello",
      enabled: true,
      whileSleeping: "skip",
    });
    assert.equal(scheduler.deliveries.length, 1);
    assert.equal(scheduler.deliveries[0].payload.whileSleeping, "skip");
  });

  it("passes whileSleeping: trigger-wake to delivery", async () => {
    const scheduler = new TestScheduler();
    await (scheduler as any).fire("test-mind", {
      id: "wake-sched",
      cron: "* * * * *",
      message: "hello",
      enabled: true,
      whileSleeping: "trigger-wake",
    });
    assert.equal(scheduler.deliveries.length, 1);
    assert.equal(scheduler.deliveries[0].payload.whileSleeping, "trigger-wake");
  });

  it("passes whileSleeping: queue to delivery", async () => {
    const scheduler = new TestScheduler();
    await (scheduler as any).fire("test-mind", {
      id: "queue-sched",
      cron: "* * * * *",
      message: "hello",
      enabled: true,
      whileSleeping: "queue",
    });
    assert.equal(scheduler.deliveries.length, 1);
    assert.equal(scheduler.deliveries[0].payload.whileSleeping, "queue");
  });

  it("maps legacy skipWhenSleeping: true to whileSleeping: skip", async () => {
    const scheduler = new TestScheduler();
    await (scheduler as any).fire("test-mind", {
      id: "legacy-skip",
      cron: "* * * * *",
      message: "hello",
      enabled: true,
      skipWhenSleeping: true,
    });
    assert.equal(scheduler.deliveries.length, 1);
    assert.equal(scheduler.deliveries[0].payload.whileSleeping, "skip");
  });

  it("does not map skipWhenSleeping: false", async () => {
    const scheduler = new TestScheduler();
    await (scheduler as any).fire("test-mind", {
      id: "legacy-no-skip",
      cron: "* * * * *",
      message: "hello",
      enabled: true,
      skipWhenSleeping: false,
    });
    assert.equal(scheduler.deliveries.length, 1);
    assert.equal(scheduler.deliveries[0].payload.whileSleeping, undefined);
  });
});
