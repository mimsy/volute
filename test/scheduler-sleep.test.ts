import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Scheduler } from "../src/lib/daemon/scheduler.js";

type SystemDelivery = {
  mindName: string;
  text: string;
  opts?: { whileSleeping?: "skip" | "queue" | "trigger-wake" };
};

class TestScheduler extends Scheduler {
  systemDeliveries: SystemDelivery[] = [];

  protected override async runScript(): Promise<string> {
    return "";
  }

  protected override async deliver(): Promise<void> {
    // Not used for system messages
  }

  protected override async deliverSystem(
    mindName: string,
    text: string,
    opts?: { whileSleeping?: "skip" | "queue" | "trigger-wake" },
  ): Promise<void> {
    this.systemDeliveries.push({ mindName, text, opts });
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
    assert.equal(scheduler.systemDeliveries.length, 1);
    assert.equal(scheduler.systemDeliveries[0].opts?.whileSleeping, undefined);
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
    assert.equal(scheduler.systemDeliveries.length, 1);
    assert.equal(scheduler.systemDeliveries[0].opts?.whileSleeping, "skip");
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
    assert.equal(scheduler.systemDeliveries.length, 1);
    assert.equal(scheduler.systemDeliveries[0].opts?.whileSleeping, "trigger-wake");
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
    assert.equal(scheduler.systemDeliveries.length, 1);
    assert.equal(scheduler.systemDeliveries[0].opts?.whileSleeping, "queue");
  });
});
