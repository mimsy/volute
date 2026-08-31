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
  revokeScriptToken,
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

  /** Skip notices the scheduler tried to hand the mind — stubbed off the DB. */
  skipNotices: { mind: string; id: string; lateBy: number }[] = [];

  protected override async noticeSkippedFire(
    mindName: string,
    schedule: Schedule,
    lateBy: number,
  ): Promise<void> {
    this.skipNotices.push({ mind: mindName, id: schedule.id, lateBy });
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
    });
    await scheduler.saveState();
    (scheduler as any).loadState();
    assert.deepEqual(stateOf(scheduler, "rt-mind", "dream"), {
      slot: 999,
      skippedAt: 1000,
      skipReason: "stale_catchup",
      dueAt: 998,
    });
    scheduler.clearState();
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
      // It is a per-run script credential scoped to this mind, distinct from the
      // mind's own long-lived token — that distinction is what lets the daemon tell a
      // process it spawned from one merely claiming to be self-initiated (#433).
      assert.equal(resolveScriptToken(token), "alice");
      assert.equal(resolveMindToken(token), null);
      revokeScriptToken(token);
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
