import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Schedule } from "../packages/daemon/src/lib/mind/volute-config.js";
import { computeClockEvents } from "../packages/daemon/src/web/api/schedules.js";

const now = new Date("2026-07-07T03:00:00");

function sleepState(overrides: Record<string, unknown> = {}) {
  return {
    sleeping: true,
    scheduledWakeAt: null,
    voluntaryWakeAt: null,
    sleepingSince: null,
    ...overrides,
  };
}

describe("computeClockEvents", () => {
  it("sleeping mind: next event is 'wake' (not 'sleep'), previous is 'sleep'", () => {
    const wakeAt = new Date("2026-07-07T08:00:00").toISOString();
    const since = new Date("2026-07-07T00:00:00").toISOString();
    const { upcoming, previous } = computeClockEvents(
      [],
      sleepState({ scheduledWakeAt: wakeAt, sleepingSince: since }),
      { enabled: true, schedule: { sleep: "0 0 * * *", wake: "0 8 * * *" } },
      now,
    );

    // Upcoming holds the wake at the scheduled wake time — never a "sleep" entry.
    assert.deepEqual(
      upcoming.find((e) => e.id === "wake"),
      { id: "wake", at: wakeAt, type: "cron" },
    );
    assert.equal(
      upcoming.some((e) => e.id === "sleep"),
      false,
    );
    // Previous correctly labels when sleep began.
    assert.deepEqual(
      previous.find((e) => e.id === "sleep"),
      { id: "sleep", at: since },
    );
  });

  it("sleeping mind: 'wake' uses the authoritative voluntaryWakeAt when scheduled is null", () => {
    const voluntary = new Date("2026-07-07T14:00:00").toISOString();
    const { upcoming } = computeClockEvents(
      [],
      sleepState({ scheduledWakeAt: null, voluntaryWakeAt: voluntary }),
      null,
      now,
    );
    assert.deepEqual(
      upcoming.find((e) => e.id === "wake"),
      { id: "wake", at: voluntary, type: "cron" },
    );
  });

  it("awake mind with sleep enabled: upcoming 'sleep', previous 'wake' (not 'sleep')", () => {
    const { upcoming, previous } = computeClockEvents(
      [],
      sleepState({ sleeping: false }),
      { enabled: true, schedule: { sleep: "0 0 * * *", wake: "0 8 * * *" } },
      now,
    );

    // Next sleep onset is still labeled "sleep".
    const nextSleep = upcoming.find((e) => e.id === "sleep");
    assert.ok(nextSleep, "expected an upcoming sleep event");
    assert.equal(nextSleep?.type, "cron");

    // The most recent sleep-related event is the wake that ended the last night.
    assert.ok(
      previous.some((e) => e.id === "wake"),
      "expected a previous 'wake' event",
    );
    // It must NOT be mislabeled "sleep".
    assert.equal(
      previous.some((e) => e.id === "sleep"),
      false,
    );
  });

  it("awake mind with sleep disabled: no sleep/wake events", () => {
    const { upcoming, previous } = computeClockEvents(
      [],
      sleepState({ sleeping: false }),
      { enabled: false, schedule: { sleep: "0 0 * * *", wake: "0 8 * * *" } },
      now,
    );
    assert.equal(
      upcoming.some((e) => e.id === "sleep" || e.id === "wake"),
      false,
    );
    assert.equal(
      previous.some((e) => e.id === "sleep" || e.id === "wake"),
      false,
    );
  });

  it("regular cron schedules appear in both upcoming and previous under their own id", () => {
    const schedules: Schedule[] = [
      { id: "heartbeat", cron: "0 * * * *", message: "beat", enabled: true },
    ];
    const { upcoming, previous } = computeClockEvents(
      schedules,
      sleepState({ sleeping: false }),
      null,
      now,
    );
    assert.ok(upcoming.some((e) => e.id === "heartbeat" && e.type === "cron"));
    assert.ok(previous.some((e) => e.id === "heartbeat"));
  });

  it("annotates fires that land during sleep by their whileSleeping fate", () => {
    const wakeAt = new Date("2026-07-07T08:00:00").toISOString();
    const schedules: Schedule[] = [
      // Next fire 04:00 < 08:00 wake → annotated by whileSleeping.
      { id: "skipme", cron: "0 * * * *", message: "x", enabled: true, whileSleeping: "skip" },
      { id: "queueme", cron: "0 * * * *", message: "x", enabled: true, whileSleeping: "queue" },
      { id: "defaultq", cron: "0 * * * *", message: "x", enabled: true }, // defaults to queue
      {
        id: "wakeme",
        cron: "0 * * * *",
        message: "x",
        enabled: true,
        whileSleeping: "trigger-wake",
      },
      // Next fire 09:00 > 08:00 wake → not annotated.
      { id: "afterwake", cron: "0 9 * * *", message: "x", enabled: true, whileSleeping: "skip" },
    ];
    const { upcoming } = computeClockEvents(
      schedules,
      sleepState({ scheduledWakeAt: wakeAt }),
      null,
      now,
    );
    const byId = (id: string) => upcoming.find((e) => e.id === id);
    assert.equal(byId("skipme")?.willSkip, true);
    assert.equal(byId("queueme")?.willQueue, true);
    assert.equal(byId("defaultq")?.willQueue, true);
    // trigger-wake fires actually happen → no skip/queue annotation.
    assert.equal(byId("wakeme")?.willSkip, undefined);
    assert.equal(byId("wakeme")?.willQueue, undefined);
    // A fire after wake isn't affected by sleep.
    assert.equal(byId("afterwake")?.willSkip, undefined);
  });

  it("omits fires beyond the 24h horizon", () => {
    const schedules: Schedule[] = [
      { id: "soon", cron: "0 * * * *", message: "x", enabled: true }, // hourly → within 24h
      { id: "faraway", cron: "0 0 1 1 *", message: "x", enabled: true }, // Jan 1 → months out
    ];
    const { upcoming } = computeClockEvents(schedules, sleepState({ sleeping: false }), null, now);
    assert.ok(upcoming.some((e) => e.id === "soon"));
    assert.equal(
      upcoming.some((e) => e.id === "faraway"),
      false,
    );
  });

  it("disabled and future/past timers behave correctly", () => {
    const schedules: Schedule[] = [
      { id: "off", cron: "0 * * * *", message: "x", enabled: false },
      {
        id: "future",
        fireAt: new Date(now.getTime() + 3600_000).toISOString(),
        message: "later",
        enabled: true,
      },
      {
        id: "past",
        fireAt: new Date(now.getTime() - 3600_000).toISOString(),
        message: "gone",
        enabled: true,
      },
    ];
    const { upcoming } = computeClockEvents(schedules, sleepState({ sleeping: false }), null, now);
    assert.equal(
      upcoming.some((e) => e.id === "off"),
      false,
    ); // disabled skipped
    assert.ok(upcoming.some((e) => e.id === "future" && e.type === "timer")); // future timer shown
    assert.equal(
      upcoming.some((e) => e.id === "past"),
      false,
    ); // past timer not upcoming
  });
});
