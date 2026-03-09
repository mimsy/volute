import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Scheduler } from "../src/lib/daemon/scheduler.js";

type DeliveryPayload = {
  content: { type: string; text: string }[];
  channel: string;
  sender: string;
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

describe("scheduler skipWhenSleeping", () => {
  it("delivers message when skipWhenSleeping is false", async () => {
    const scheduler = new TestScheduler();
    await (scheduler as any).fire("test-mind", {
      id: "no-skip",
      cron: "* * * * *",
      message: "hello",
      enabled: true,
      skipWhenSleeping: false,
    });
    assert.equal(scheduler.deliveries.length, 1);
  });

  it("delivers message when skipWhenSleeping is undefined", async () => {
    const scheduler = new TestScheduler();
    await (scheduler as any).fire("test-mind", {
      id: "no-flag",
      cron: "* * * * *",
      message: "hello",
      enabled: true,
    });
    assert.equal(scheduler.deliveries.length, 1);
  });

  it("delivers when skipWhenSleeping is true but sleep manager not initialized", async () => {
    // When no sleep manager is available (getSleepManagerIfReady returns null),
    // schedules should still fire
    const scheduler = new TestScheduler();
    await (scheduler as any).fire("test-mind", {
      id: "skip-no-manager",
      cron: "* * * * *",
      message: "hello",
      enabled: true,
      skipWhenSleeping: true,
    });
    // In test environment, getSleepManagerIfReady() returns null, so message delivers
    assert.equal(scheduler.deliveries.length, 1);
  });
});
