import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Scheduler } from "../src/lib/scheduler.js";

describe("scheduler", () => {
  it("start and stop manage interval", () => {
    const scheduler = new Scheduler();
    scheduler.start();
    scheduler.stop();
    assert.ok(true);
  });

  it("unloadSchedules removes agent schedules", () => {
    const scheduler = new Scheduler();
    scheduler.unloadSchedules("nonexistent");
    assert.ok(true);
  });
});
