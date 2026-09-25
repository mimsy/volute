import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { _resetConfigCache } from "../packages/daemon/src/lib/config/setup.js";
import {
  resolveMindToken,
  resolveScriptToken,
  revokeMindToken,
} from "../packages/daemon/src/lib/daemon/mind-tokens.js";
import { Scheduler } from "../packages/daemon/src/lib/daemon/scheduler.js";
import { voluteSystemDir } from "../packages/daemon/src/lib/mind/registry.js";
import { SandboxUnavailableError } from "../packages/daemon/src/lib/mind/sandbox.js";
import type { Schedule } from "../packages/daemon/src/lib/mind/volute-config.js";

type SystemDelivery = {
  mindName: string;
  scheduleId: string;
  text: string;
  opts?: { whileSleeping?: "skip" | "queue" | "trigger-wake"; thread?: string };
};

/** Test subclass that captures calls instead of running real exec/deliver */
class TestScheduler extends Scheduler {
  /**
   * Each instance persists to its own file. Production has one Scheduler and one
   * path, but these tests build many, and several fire un-awaited saves — sharing
   * the real `voluteSystemDir()` file let one instance's late write clobber
   * another's, which is a flake in the test rig, not in the scheduler.
   */
  readonly stateFile = resolve(mkdtempSync(join(tmpdir(), "sched-state-")), "state.json");

  protected override get statePath(): string {
    return this.stateFile;
  }

  systemDeliveries: SystemDelivery[] = [];
  scriptCalls: { script: string; cwd: string; mindName: string }[] = [];
  scriptResult: string | Error = "";
  /** When set, the stubbed script blocks on it — lets a test hold a run in flight. */
  scriptGate: Promise<void> | null = null;

  protected override async runScript(
    script: string,
    cwd: string,
    mindName: string,
  ): Promise<string> {
    this.scriptCalls.push({ script, cwd, mindName });
    if (this.scriptGate) await this.scriptGate;
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

  /** Skip notices the scheduler tried to hand the mind — stubbed off the DB. */
  skipNotices: { mind: string; id: string; lateBy: number }[] = [];

  protected override async noticeSkippedFire(
    mindName: string,
    schedule: Schedule,
    lateBy: number,
  ): Promise<void> {
    this.skipNotices.push({ mind: mindName, id: schedule.id, lateBy });
  }

  /** Malformed-schedule notices, captured and then recorded for real. */
  invalidNotices: { mind: string; id: string; reason: string }[] = [];

  protected override async noticeInvalidSchedule(
    mindName: string,
    schedule: Schedule,
    reason: string,
  ): Promise<void> {
    this.invalidNotices.push({ mind: mindName, id: schedule.id, reason });
    await super.noticeInvalidSchedule(mindName, schedule, reason);
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
    assert.equal(scheduler.systemDeliveries[0].opts?.thread, "$new");
  });

  it("fire uses legacy channel as thread fallback", async () => {
    const scheduler = new TestScheduler();
    await (scheduler as any).fire("test-mind", {
      id: "dream",
      cron: "0 3 * * *",
      message: "time to dream",
      enabled: true,
      channel: "system:dream",
    });
    // Legacy channel is ignored — no thread override
    assert.equal(scheduler.systemDeliveries.length, 1);
    assert.equal(scheduler.systemDeliveries[0].opts?.thread, undefined);
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

describe("scheduler one-time consumption (#866)", () => {
  /** A fire()-able scheduler whose removeSchedule is captured instead of writing config. */
  function schedulerWithRemovals() {
    const scheduler = new TestScheduler();
    const removed: string[] = [];
    (scheduler as any).removeSchedule = (_mind: string, id: string) => removed.push(id);
    return { scheduler, removed };
  }

  const past = () => new Date(Date.now() - 60000).toISOString();

  it("consumes a one-time script that produced no output", async () => {
    // The common case: a one-timer whose whole job is a side effect prints
    // nothing by design. Skipping delivery is right; skipping consumption left
    // it re-firing every tick forever.
    const { scheduler, removed } = schedulerWithRemovals();
    scheduler.scriptResult = "";

    await (scheduler as any).fire("test-mind", {
      id: "quiet-timer",
      fireAt: past(),
      script: "touch /tmp/whatever",
      enabled: true,
    });

    assert.equal(scheduler.systemDeliveries.length, 0, "nothing to deliver");
    assert.deepEqual(removed, ["quiet-timer"], "but the one-timer is consumed");
  });

  it("leaves a recurring no-output script alone", async () => {
    // The consumption rule is about one-timers only — a cron script that prints
    // nothing must keep running on its schedule.
    const { scheduler, removed } = schedulerWithRemovals();
    scheduler.scriptResult = "";

    await (scheduler as any).fire("test-mind", {
      id: "quiet-cron",
      cron: "* * * * *",
      script: "true",
      enabled: true,
    });

    assert.deepEqual(removed, [], "recurring schedules are never consumed");
  });

  it("consumes a one-timer that can never act (hand-edited config)", async () => {
    // Actionless and malformed-pool entries can only come from a hand-edited
    // volute.json (the API validates), and a one-timer that can never deliver
    // anything is dead — consume it rather than warn every minute forever.
    const { scheduler, removed } = schedulerWithRemovals();

    await (scheduler as any).fire("test-mind", {
      id: "actionless",
      fireAt: past(),
      enabled: true,
    });
    await (scheduler as any).fire("test-mind", {
      id: "malformed",
      fireAt: past(),
      messages: [42],
      enabled: true,
    });

    assert.equal(scheduler.systemDeliveries.length, 0);
    assert.deepEqual(removed, ["actionless", "malformed"]);
  });

  // The negative case — a one-timer kept armed when the event row could not be
  // recorded at all — is covered by "fireAt is retained when the event row could
  // not be recorded at all" above.
});

describe("scheduler state honesty (#867)", () => {
  const nowMin = () => Math.floor(Date.now() / 60000);

  /** Read one schedule's bookkeeping out of the in-memory map. */
  function stateOf(scheduler: Scheduler, mind: string, id: string) {
    return ((scheduler as any).state as Map<string, any>).get(`${mind}:${id}`);
  }

  /** Read the persisted state file — the surface a host actually inspects. */
  function readStateFile(scheduler: TestScheduler): Record<string, any> {
    return JSON.parse(readFileSync(scheduler.stateFile, "utf-8"));
  }

  it("records firedAt only when a fire was actually dispatched", async () => {
    const scheduler = new TestScheduler();
    (scheduler as any).state.set("test-mind:beat", { slot: nowMin() });

    // Capture before firing: firedAt is stamped inside fire(), and comparing it
    // to a second Date.now() at assert time straddles the minute boundary.
    const before = nowMin();
    await (scheduler as any).fire("test-mind", {
      id: "beat",
      cron: "* * * * *",
      message: "hi",
      enabled: true,
    });

    const state = stateOf(scheduler, "test-mind", "beat");
    assert.ok(
      state?.firedAt !== undefined && state.firedAt >= before,
      "a delivered fire is recorded as delivered",
    );
    assert.equal(state?.skippedAt, undefined);
  });

  it("does not record firedAt when the event row could not be recorded", async () => {
    const scheduler = new TestScheduler();
    (scheduler as any).state.set("test-mind:beat", { slot: nowMin() });
    scheduler.deliverResult = { id: undefined, delivered: false };

    await (scheduler as any).fire("test-mind", {
      id: "beat",
      cron: "* * * * *",
      message: "hi",
      enabled: true,
    });

    assert.equal(stateOf(scheduler, "test-mind", "beat")?.firedAt, undefined);
  });

  it("records a silent script's fire — a side-effect script that ran is not 'never ran'", async () => {
    const scheduler = new TestScheduler();
    scheduler.scriptResult = "";
    (scheduler as any).state.set("test-mind:backup", { slot: nowMin() });
    const before = nowMin();

    await (scheduler as any).fire("test-mind", {
      id: "backup",
      cron: "0 4 * * *",
      script: "restic backup",
      enabled: true,
    });

    const state = stateOf(scheduler, "test-mind", "backup");
    assert.ok(state?.firedAt !== undefined && state.firedAt >= before);
  });

  it("a stale skip is recorded as a skip, not as a fire, and reaches the mind", () => {
    // The production failure: mimsy:dream showed a slot cursor at 03:00 for a
    // dream that provably never ran, and the only other trace was a daemon log
    // line a mind's sandbox cannot read.
    const scheduler = new TestScheduler();
    const realMin = nowMin();
    const epochMinute = realMin + 20;
    (scheduler as any).state.set("test-mind:dream", { slot: realMin - 30 });

    const result = (scheduler as any).shouldFire(
      { id: "dream", cron: "* * * * *", enabled: true },
      epochMinute,
      "test-mind",
      new Map(),
    );

    assert.equal(result, false);
    const state = stateOf(scheduler, "test-mind", "dream");
    assert.equal(state?.slot, realMin, "cursor advanced so it isn't retried");
    assert.equal(state?.skippedAt, epochMinute, "skippedAt is when we acted, like firedAt");
    assert.equal(state?.skipReason, "stale_catchup");
    assert.equal(state?.firedAt, undefined);
    assert.deepEqual(scheduler.skipNotices, [{ mind: "test-mind", id: "dream", lateBy: 20 }]);
  });

  it("persists a skip-only tick to disk, so a restart doesn't re-skip and re-notify", async () => {
    // The notice is durable but the cursor advance was not: tick() saved only
    // when something fired, so a tick of pure skips mutated memory and wrote
    // nothing. After a restart the old slot returned, the same missed fire was
    // skipped again, and the mind got a second notice for it — turning a fix for
    // dropped fires into a source of duplicate ones.
    const scheduler = new TestScheduler();
    const realMin = nowMin();
    const key = "persist-mind:dream";
    (scheduler as any).state.set(key, { slot: realMin - 5000 });
    (scheduler as any).schedules.set("persist-mind", [
      { id: "dream", cron: "0 3 * * *", message: "dream", enabled: true },
    ]);

    await (scheduler as any).tick();

    assert.equal(scheduler.systemDeliveries.length, 0, "the stale fire was skipped, not delivered");
    assert.equal(scheduler.skipNotices.length, 1, "and the mind was told once");

    const onDisk = readStateFile(scheduler)[key];
    assert.ok(onDisk, "the skip reached disk");
    assert.equal(onDisk.skipReason, "stale_catchup");
    assert.ok(
      onDisk.slot > realMin - 5000,
      "the advanced cursor is durable, so the next boot won't re-skip",
    );

    scheduler.clearState();
  });

  it("records how late a one-timer was, so late never reads as punctual", () => {
    const scheduler = new TestScheduler();
    const due = new Date(Date.now() - 3 * 3600_000);
    const result = (scheduler as any).shouldFire(
      { id: "walk", fireAt: due.toISOString(), enabled: true },
      nowMin(),
      "test-mind",
      new Map(),
    );
    // Deliberate asymmetry with recurring fires: a one-time reminder is the only
    // copy of that intention, so lateness never becomes a drop.
    assert.equal(result, true);
    assert.equal(scheduler.skipNotices.length, 0);

    const state = stateOf(scheduler, "test-mind", "walk");
    assert.equal(state?.dueAt, Math.floor(due.getTime() / 60000), "when it was due");
    assert.equal(state?.slot, nowMin(), "and when we acted — the gap is the lateness");
  });

  it("drops the state key when a schedule is removed, so a reused id starts clean", () => {
    // `clock add --id reminder --in 5m` is a natural repeat. A surviving key
    // would hand the new schedule the old one's slot and firedAt.
    const scheduler = new TestScheduler();
    const key = "reuse-mind:reminder";
    (scheduler as any).state.set(key, { slot: 100, firedAt: 100 });
    (scheduler as any).schedules.set("reuse-mind", [
      { id: "reminder", fireAt: new Date().toISOString(), message: "hi", enabled: true },
    ]);

    (scheduler as any).removeSchedule("reuse-mind", "reminder");

    assert.equal(stateOf(scheduler, "reuse-mind", "reminder"), undefined);
    scheduler.clearState();
  });

  it("addresses the skip notice mind-level so it can't strand on a dead thread", async () => {
    // The notice is about a fire that did NOT happen, and a schedule's thread is
    // often a thread only that schedule ever opens (a dream prompt opens the
    // dream thread). A next-turn event on a named thread is drained only by that
    // thread's turns, so addressing it there would strand it in exactly the case
    // it exists for. Mind-level events are drained by any thread's next turn.
    const { getDb } = await import("../packages/daemon/src/lib/db.js");
    const { systemEvents } = await import("../packages/daemon/src/lib/schema.js");
    const { eq } = await import("drizzle-orm");
    const mind = "skip-notice-mind";

    const scheduler = new Scheduler();
    await (scheduler as any).noticeSkippedFire(
      mind,
      { id: "dream", cron: "0 3 * * *", enabled: true, thread: "dream" },
      241,
    );

    const db = await getDb();
    const rows = await db.select().from(systemEvents).where(eq(systemEvents.mind, mind)).all();
    assert.equal(rows.length, 1, "one notice recorded");
    assert.equal(rows[0].thread, "", "mind-level, not the schedule's own thread");
    assert.equal(rows[0].delivery, "next-turn");
    assert.match(rows[0].meta ?? "", /schedule_skipped_stale/);
    assert.match(rows[0].body, /dream/);
    assert.match(rows[0].body, /241/);
    assert.doesNotMatch(
      rows[0].body,
      /daemon was down/,
      "must not assert a cause it cannot know — a deliberate stop produces this too",
    );

    await db.delete(systemEvents).where(eq(systemEvents.mind, mind));
  });

  it("tells the mind when a malformed schedule could not send anything", async () => {
    // Hand-edit-only states. A one-timer in this shape is consumed below, so
    // without a notice the mind's reminder would vanish over a typo with nothing
    // but a daemon log line it cannot read.
    const { getDb } = await import("../packages/daemon/src/lib/db.js");
    const { systemEvents } = await import("../packages/daemon/src/lib/schema.js");
    const { eq } = await import("drizzle-orm");
    const mind = "invalid-sched-mind";

    const scheduler = new TestScheduler();
    await (scheduler as any).fire(mind, {
      id: "typo",
      fireAt: new Date(Date.now() - 60000).toISOString(),
      messages: [42],
      enabled: true,
    });

    const db = await getDb();
    const rows = await db.select().from(systemEvents).where(eq(systemEvents.mind, mind)).all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].thread, "");
    assert.match(rows[0].meta ?? "", /schedule_invalid/);
    assert.match(rows[0].body, /typo/);
    assert.match(rows[0].body, /removed/, "and says the one-timer is gone");

    await db.delete(systemEvents).where(eq(systemEvents.mind, mind));
  });

  it("round-trips the fire history through the state file", async () => {
    const scheduler = new TestScheduler();
    (scheduler as any).state.set("rt-mind:dream", {
      slot: 999,
      skippedAt: 1000,
      skipReason: "stale_catchup",
      dueAt: 998,
      cron: "0 3 * * *",
      fireAt: "2026-01-01T00:00:00.000Z",
    });
    await scheduler.saveState();
    (scheduler as any).loadState();
    assert.deepEqual(stateOf(scheduler, "rt-mind", "dream"), {
      slot: 999,
      skippedAt: 1000,
      skipReason: "stale_catchup",
      dueAt: 998,
      cron: "0 3 * * *",
      fireAt: "2026-01-01T00:00:00.000Z",
    });
    scheduler.clearState();
  });
});

describe("scheduler script timeout (#989)", () => {
  /**
   * A scheduler that runs the *real* `runScript` (so the exec/kill path is under
   * test) on a short fuse, with delivery captured off the DB.
   */
  class TimedScheduler extends Scheduler {
    readonly stateFile = resolve(mkdtempSync(join(tmpdir(), "sched-timeout-")), "state.json");
    deliveries: { text: string }[] = [];

    constructor(private readonly timeoutMs: number) {
      super();
    }

    protected override get statePath(): string {
      return this.stateFile;
    }

    protected override get scriptTimeoutMs(): number {
      return this.timeoutMs;
    }

    protected override async deliverSystem(
      _mindName: string,
      _scheduleId: string,
      text: string,
    ): Promise<{ id?: number; delivered: boolean }> {
      this.deliveries.push({ text });
      return { id: 1, delivered: true };
    }
  }

  const origSandbox = process.env.VOLUTE_SANDBOX;

  afterEach(() => {
    if (origSandbox === undefined) delete process.env.VOLUTE_SANDBOX;
    else process.env.VOLUTE_SANDBOX = origSandbox;
    revokeMindToken("timeout-mind");
  });

  /** True once the pid is gone. A killed process may linger briefly as a zombie. */
  async function waitForDeath(pid: number, budgetMs = 5000): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  it("kills a script that outruns its timeout, its children with it, and tells the mind", {
    timeout: 30_000,
  }, async () => {
    process.env.VOLUTE_SANDBOX = "0";
    const dir = mkdtempSync(join(tmpdir(), "sched-mind-"));
    mkdirSync(join(dir, "home"), { recursive: true });
    const pidFile = join(dir, "child.pid");
    const tokenFile = join(dir, "token");

    const scheduler = new TimedScheduler(500);
    (scheduler as any).mindDirs.set("timeout-mind", dir);

    // The background `sleep` is the discriminator: it is a *different* process
    // from the bash the daemon spawned, so it survives anything that signals
    // only the immediate child, and it survives a `kill(-pid)` aimed at a
    // process that was never made a group leader.
    await (scheduler as any).fire("timeout-mind", {
      id: "hangs",
      cron: "* * * * *",
      script: `printf '%s' "$VOLUTE_MIND_TOKEN" > ${tokenFile}; sleep 120 & echo $! > ${pidFile}; wait`,
      enabled: true,
    });

    assert.equal(scheduler.deliveries.length, 1, "the mind is told, not left guessing");
    const text = scheduler.deliveries[0].text;
    assert.match(text, /\[script timeout\]/);
    // The bound is named as configured, so a shortened one never reports as
    // the production "10 minutes".
    assert.match(text, /timed out after 500ms and was killed/);

    const childPid = Number(readFileSync(pidFile, "utf-8").trim());
    assert.ok(childPid > 0, "the script's background child should have recorded its pid");
    assert.ok(
      await waitForDeath(childPid),
      `background child ${childPid} survived the timeout — the process group was not killed`,
    );

    // The per-run credential dies with the run even when the run had to be
    // killed: a hung script must not leave a live token behind.
    const token = readFileSync(tokenFile, "utf-8").trim();
    assert.ok(token.length > 0, "the script should have received a token");
    assert.equal(resolveScriptToken(token), null, "token must be revoked after a timeout");
  });

  it("does not wait on a grandchild that kept stdout open", async () => {
    process.env.VOLUTE_SANDBOX = "0";
    // The shell prints and exits, but its backgrounded child inherited the
    // stdout pipe and holds it for three seconds, so `close` is three seconds
    // away. The output is already complete — waiting for `close` unconditionally
    // would stall every fire behind whatever the script left running.
    const scheduler = new TimedScheduler(30_000);
    const started = Date.now();
    const out = await (
      scheduler as unknown as {
        runScript: (s: string, cwd: string, m: string) => Promise<string>;
      }
    ).runScript("sleep 3 & printf hello", "/tmp", "timeout-mind");
    const elapsed = Date.now() - started;
    assert.equal(out, "hello", "output present despite settling before close");
    assert.ok(elapsed < 2500, `settled in ${elapsed}ms — the drain wait is not bounded`);
  });

  it("returns a script's full output, not whatever had arrived by exit", async () => {
    process.env.VOLUTE_SANDBOX = "0";
    // Past the 64KB pipe buffer, so the data cannot all be sitting in the pipe
    // before the child exits. Node emits `exit` and flushes stdio on a later
    // tick, and which of the two the poll loop services first is a platform
    // detail — settling straight from `exit` would return a truncated (on some
    // platforms empty) result for every ordinary scheduled script.
    const scheduler = new TimedScheduler(30_000);
    const out = await (
      scheduler as unknown as {
        runScript: (s: string, cwd: string, m: string) => Promise<string>;
      }
    ).runScript(`printf 'x%.0s' $(seq 1 200000)`, "/tmp", "timeout-mind");
    assert.equal(out.length, 200000);
  });

  it("escalates to SIGKILL even when the script's own shell died on the SIGTERM", {
    timeout: 30_000,
  }, async () => {
    process.env.VOLUTE_SANDBOX = "0";
    const dir = mkdtempSync(join(tmpdir(), "sched-mind-"));
    mkdirSync(join(dir, "home"), { recursive: true });
    const pidFile = join(dir, "child.pid");

    const scheduler = new TimedScheduler(300);
    (scheduler as any).mindDirs.set("timeout-mind", dir);

    // The nastiest shape, and the one that is easy to get wrong: the group
    // *leader* obeys the SIGTERM and dies, so the run settles and the mind is
    // told its script was killed — while a member that ignores SIGTERM keeps
    // going. Disarming the escalation on the leader's exit turns the whole
    // bound into a lie: the notice says killed and the work runs forever.
    await (scheduler as any).fire("timeout-mind", {
      id: "survivor",
      cron: "* * * * *",
      script: `bash -c "trap '' TERM; sleep 120" & echo $! > ${pidFile}; wait`,
      enabled: true,
    });

    const childPid = Number(readFileSync(pidFile, "utf-8").trim());
    assert.ok(
      await waitForDeath(childPid, 10_000),
      `group member ${childPid} outlived its leader's death — the escalation was disarmed early`,
    );
    assert.match(scheduler.deliveries[0]?.text ?? "", /\[script timeout\]/);
  });

  it("escalates to SIGKILL for a script that ignores SIGTERM", { timeout: 30_000 }, async () => {
    process.env.VOLUTE_SANDBOX = "0";
    const dir = mkdtempSync(join(tmpdir(), "sched-mind-"));
    mkdirSync(join(dir, "home"), { recursive: true });
    const pidFile = join(dir, "child.pid");

    const scheduler = new TimedScheduler(300);
    (scheduler as any).mindDirs.set("timeout-mind", dir);

    // An ignored disposition survives fork and exec, so both the bash and the
    // `sleep` it starts are deaf to SIGTERM. A timeout that sends one signal
    // and never follows up leaves this running forever — which is the bound
    // not being a bound at all.
    await (scheduler as any).fire("timeout-mind", {
      id: "stubborn",
      cron: "* * * * *",
      script: `trap '' TERM; sleep 120 & echo $! > ${pidFile}; wait`,
      enabled: true,
    });

    const childPid = Number(readFileSync(pidFile, "utf-8").trim());
    assert.ok(
      await waitForDeath(childPid, 8000),
      `SIGTERM-ignoring script ${childPid} survived — the kill never escalated`,
    );
    assert.match(scheduler.deliveries[0]?.text ?? "", /\[script timeout\]/);
  });

  // Timeout-bounded: without the in-flight guard the second fire blocks on the
  // gate and this hangs rather than failing.
  it("does not fire a schedule whose previous script run is still going", {
    timeout: 10_000,
  }, async () => {
    const scheduler = new TestScheduler();
    const removed: string[] = [];
    (scheduler as any).removeSchedule = (_m: string, id: string) => removed.push(id);

    let release!: () => void;
    scheduler.scriptGate = new Promise<void>((r) => {
      release = r;
    });
    scheduler.scriptResult = "done";

    const schedule = {
      id: "slow-timer",
      fireAt: new Date(Date.now() - 60000).toISOString(),
      script: "sleep 600",
      enabled: true,
    };

    const first = (scheduler as any).fire("test-mind", schedule);
    // The tick that follows a minute later, while the first run is still hung.
    await (scheduler as any).fire("test-mind", schedule);
    await (scheduler as any).fire("test-mind", schedule);

    assert.equal(scheduler.scriptCalls.length, 1, "a hung run must not be stacked on");
    assert.equal(scheduler.systemDeliveries.length, 0, "the skipped fires deliver nothing");
    assert.deepEqual(removed, [], "the in-flight run still owns consuming the one-timer");

    release();
    await first;

    assert.deepEqual(removed, ["slow-timer"], "and does consume it when it finishes");
    assert.equal(scheduler.systemDeliveries.length, 1);

    // Once the run is done the schedule is firable again — the guard bounds a
    // run, it doesn't retire the schedule.
    scheduler.scriptGate = null;
    await (scheduler as any).fire("test-mind", {
      ...schedule,
      fireAt: undefined,
      cron: "* * * * *",
    });
    assert.equal(scheduler.scriptCalls.length, 2);
  });

  it("records the skipped fire in the state file rather than leaving a silent gap", {
    timeout: 10_000,
  }, async () => {
    const scheduler = new TestScheduler();
    let release!: () => void;
    scheduler.scriptGate = new Promise<void>((r) => {
      release = r;
    });

    const schedule = { id: "busy", cron: "* * * * *", script: "sleep 600", enabled: true };
    const first = (scheduler as any).fire("test-mind", schedule);
    await (scheduler as any).fire("test-mind", schedule);

    const entry = (scheduler as any).state.get("test-mind:busy");
    assert.equal(entry?.skipReason, "in_flight");
    assert.ok(typeof entry?.skippedAt === "number");

    release();
    await first;
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
      // A per-run script credential, not the mind's own long-lived token, and revoked
      // with the run — so by now it resolves to nothing at all (#433).
      assert.equal(resolveScriptToken(token), null);
      assert.equal(resolveMindToken(token), null);
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
    // Last acted-on slot is 3 minutes stale (missed ticks).
    (scheduler as any).state.set(key, { slot: epochMinute - 3 });

    const first = (scheduler as any).shouldFire(heartbeat, epochMinute, "test-mind", new Map());
    assert.equal(first, true);
    // The slot cursor advances to the fired cron minute (== epochMinute for every-minute cron).
    assert.equal((scheduler as any).state.get(key).slot, epochMinute);

    // Same minute again → no double fire.
    const second = (scheduler as any).shouldFire(heartbeat, epochMinute, "test-mind", new Map());
    assert.equal(second, false);
  });

  it("does not fire when already up to date this minute", () => {
    const scheduler = new TestScheduler();
    const epochMinute = nowMin();
    (scheduler as any).state.set("test-mind:heartbeat", { slot: epochMinute });
    const result = (scheduler as any).shouldFire(heartbeat, epochMinute, "test-mind", new Map());
    assert.equal(result, false);
  });

  it("skips a stale catch-up fire but still advances the slot cursor", () => {
    const scheduler = new TestScheduler();
    const realMin = nowMin();
    // Pretend we're evaluating 20 minutes after the cron minute (long downtime).
    const epochMinute = realMin + 20;
    const key = "test-mind:dream";
    (scheduler as any).state.set(key, { slot: realMin - 30 });

    const result = (scheduler as any).shouldFire(
      { id: "dream", cron: "* * * * *", enabled: true },
      epochMinute,
      "test-mind",
      new Map(),
    );
    // Too stale to deliver...
    assert.equal(result, false);
    // ...but the cursor advanced to the cron minute so it won't be retried.
    assert.equal((scheduler as any).state.get(key).slot, realMin);
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

    const lf = (scheduler as any).state as Map<string, { slot: number }>;
    // Pre-seed: a stale key for this mind + a live key for another mind.
    lf.set("sched-bookkeep-mind:old-removed", { slot: 100 });
    lf.set("other-mind:keepme", { slot: 200 });

    scheduler.loadSchedules("sched-bookkeep-mind", dir);

    // Stale key for this mind pruned (#428).
    assert.equal(lf.has("sched-bookkeep-mind:old-removed"), false);
    // Other mind's key untouched — prune is per-mind only.
    assert.equal(lf.get("other-mind:keepme")?.slot, 200);
    // New schedule baselined to the current minute (#453) so no history replay.
    assert.equal(lf.get("sched-bookkeep-mind:heartbeat")?.slot, Math.floor(Date.now() / 60000));
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

describe("scheduler schedule edits keep their history without false skips (#948)", () => {
  const nowMin = () => Math.floor(Date.now() / 60000);

  function writeConfig(dir: string, schedules: unknown[]) {
    mkdirSync(resolve(dir, "home/.config"), { recursive: true });
    writeFileSync(resolve(dir, "home/.config/volute.json"), JSON.stringify({ schedules }));
  }

  /** A daily cron whose most recent fire was `minutesAgo` minutes ago. */
  function dailyCronAgo(minutesAgo: number): string {
    const d = new Date(Date.now() - minutesAgo * 60000);
    return `${d.getMinutes()} ${d.getHours()} * * *`;
  }

  function stateOf(scheduler: Scheduler, key: string) {
    return ((scheduler as any).state as Map<string, any>).get(key);
  }

  it("remove then add of the same id starts clean: no replay, no skip notice", () => {
    const scheduler = new TestScheduler();
    const mind = "edit-readd-mind";
    const dir = resolve(voluteSystemDir(), mind);
    const cron = dailyCronAgo(60);
    const dream = { id: "dream", cron, message: "dream", enabled: true };
    (scheduler as any).state.set(`${mind}:dream`, {
      slot: nowMin() - 600,
      firedAt: nowMin() - 600,
      cron: "0 3 * * *",
    });

    writeConfig(dir, []);
    scheduler.loadSchedules(mind, dir); // clock remove
    writeConfig(dir, [dream]);
    scheduler.loadSchedules(mind, dir); // clock add

    const fired = (scheduler as any).shouldFire(dream, nowMin(), mind, new Map());
    assert.equal(fired, false);
    assert.deepEqual(scheduler.skipNotices, []);
  });

  it("editing a cron in place re-baselines the cursor and keeps the fire history", () => {
    // The false alarm: tuned `0 3` to fire an hour ago, and the mind is told
    // the new slot "did not run" — a fire that was never due under either cron.
    const scheduler = new TestScheduler();
    const mind = "edit-cron-mind";
    const dir = resolve(voluteSystemDir(), mind);
    const firedAt = nowMin() - 600;
    (scheduler as any).state.set(`${mind}:dream`, { slot: firedAt, firedAt, cron: "0 3 * * *" });

    const cron = dailyCronAgo(60);
    const dream = { id: "dream", cron, message: "dream", enabled: true };
    writeConfig(dir, [dream]);
    scheduler.loadSchedules(mind, dir);

    const fired = (scheduler as any).shouldFire(dream, nowMin(), mind, new Map());
    assert.equal(fired, false);
    assert.deepEqual(scheduler.skipNotices, [], "an edit is not a skipped fire");
    const state = stateOf(scheduler, `${mind}:dream`);
    assert.equal(state.slot, nowMin());
    assert.equal(state.cron, cron);
    assert.equal(state.firedAt, firedAt, "the schedule's history survives the edit");
  });

  it("adopts an entry saved before the cron was recorded, keeping its catch-up", () => {
    const scheduler = new TestScheduler();
    const mind = "edit-legacy-mind";
    const dir = resolve(voluteSystemDir(), mind);
    const beat = { id: "beat", cron: "* * * * *", message: "hi", enabled: true };
    (scheduler as any).state.set(`${mind}:beat`, { slot: nowMin() - 3 });
    writeConfig(dir, [beat]);

    scheduler.loadSchedules(mind, dir);

    assert.equal(stateOf(scheduler, `${mind}:beat`).cron, "* * * * *");
    assert.equal((scheduler as any).shouldFire(beat, nowMin(), mind, new Map()), true);
  });

  it("an unchanged cron keeps its cursor, so a real catch-up still fires", () => {
    const scheduler = new TestScheduler();
    const mind = "edit-same-mind";
    const dir = resolve(voluteSystemDir(), mind);
    const beat = { id: "beat", cron: "* * * * *", message: "hi", enabled: true };
    (scheduler as any).state.set(`${mind}:beat`, { slot: nowMin() - 3, cron: "* * * * *" });
    writeConfig(dir, [beat]);

    scheduler.loadSchedules(mind, dir);

    assert.equal((scheduler as any).shouldFire(beat, nowMin(), mind, new Map()), true);
  });

  it("a one-timer turned recurring is re-baselined, not caught up from its creation", () => {
    const scheduler = new TestScheduler();
    const mind = "edit-once-to-cron-mind";
    const dir = resolve(voluteSystemDir(), mind);
    const later = new Date(Date.now() + 3_600_000).toISOString();
    writeConfig(dir, [{ id: "dream", fireAt: later, message: "dream", enabled: true }]);
    scheduler.loadSchedules(mind, dir);
    stateOf(scheduler, `${mind}:dream`).slot = nowMin() - 600; // created hours ago

    const dream = { id: "dream", cron: dailyCronAgo(60), message: "dream", enabled: true };
    writeConfig(dir, [dream]);
    scheduler.loadSchedules(mind, dir);

    assert.equal((scheduler as any).shouldFire(dream, nowMin(), mind, new Map()), false);
    assert.deepEqual(scheduler.skipNotices, []);
    assert.equal(stateOf(scheduler, `${mind}:dream`).fireAt, undefined);
  });

  it("a cron switched to a one-timer and back is re-baselined on the way back", () => {
    const scheduler = new TestScheduler();
    const mind = "edit-cron-once-cron-mind";
    const dir = resolve(voluteSystemDir(), mind);
    const cron = dailyCronAgo(60);
    const dream = { id: "dream", cron, message: "dream", enabled: true };
    writeConfig(dir, [dream]);
    scheduler.loadSchedules(mind, dir);
    stateOf(scheduler, `${mind}:dream`).slot = nowMin() - 60 - 1440; // yesterday's fire

    const later = new Date(Date.now() + 3_600_000).toISOString();
    writeConfig(dir, [{ id: "dream", fireAt: later, message: "dream", enabled: true }]);
    scheduler.loadSchedules(mind, dir);
    assert.equal(stateOf(scheduler, `${mind}:dream`).cron, undefined);
    writeConfig(dir, [dream]);
    scheduler.loadSchedules(mind, dir);

    assert.equal((scheduler as any).shouldFire(dream, nowMin(), mind, new Map()), false);
    assert.deepEqual(scheduler.skipNotices, []);
  });

  it("an undated schedule is skipped with a recorded reason and one notice, not silence", () => {
    const scheduler = new TestScheduler();
    const mind = "undated-mind";
    const empty = { id: "empty", message: "hi", enabled: true };

    for (let i = 0; i < 3; i++) {
      assert.equal((scheduler as any).shouldFire(empty, nowMin() + i, mind, new Map()), false);
    }

    const state = stateOf(scheduler, `${mind}:empty`);
    assert.equal(state.skipReason, "undated");
    assert.equal(scheduler.invalidNotices.length, 1, "told once, not every tick");
    assert.match(scheduler.invalidNotices[0].reason, /neither a cron nor a fireAt/);
  });

  it("dating an undated schedule re-baselines it rather than catching up", () => {
    const scheduler = new TestScheduler();
    const mind = "undated-fixed-mind";
    const dir = resolve(voluteSystemDir(), mind);
    (scheduler as any).state.set(`${mind}:dream`, {
      slot: nowMin() - 600,
      skippedAt: nowMin() - 600,
      skipReason: "undated",
    });
    const dream = { id: "dream", cron: dailyCronAgo(60), message: "dream", enabled: true };
    writeConfig(dir, [dream]);

    scheduler.loadSchedules(mind, dir);

    assert.equal((scheduler as any).shouldFire(dream, nowMin(), mind, new Map()), false);
    assert.deepEqual(scheduler.skipNotices, []);
    assert.equal(stateOf(scheduler, `${mind}:dream`).skipReason, undefined);
  });

  it("a one-timer whose fireAt is not a date is consumed with a notice, not fired", () => {
    const scheduler = new TestScheduler();
    const mind = "undated-once-mind";
    const bad = { id: "later", fireAt: "tomorrow-ish", message: "hi", enabled: true };
    (scheduler as any).schedules.set(mind, [bad]);

    assert.equal((scheduler as any).shouldFire(bad, nowMin(), mind, new Map()), false);

    assert.equal(scheduler.invalidNotices.length, 1);
    assert.match(scheduler.invalidNotices[0].reason, /not a valid date/);
    assert.equal((scheduler as any).schedules.has(mind), false, "consumed");
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
