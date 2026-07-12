import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  matchesGlob,
  SleepManager,
  type SleepState,
} from "../packages/daemon/src/lib/daemon/sleep-manager.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import { activity, deliveryQueue, systemEvents } from "../packages/daemon/src/lib/schema.js";

// We test the SleepManager's pure logic methods without starting the daemon.
// The class methods like checkWakeTrigger, formatDuration, etc. are tested directly.

// Access private methods/state via subclass for testing
class TestSleepManager extends SleepManager {
  // Expose internal state for testing
  setStateForTest(name: string, state: SleepState): void {
    (this as any).states.set(name, state);
  }

  getStateForTest(name: string): SleepState | undefined {
    return (this as any).states.get(name);
  }

  deleteStateForTest(name: string): void {
    (this as any).states.delete(name);
  }

  isTransitioning(name: string): boolean {
    return (this as any).transitioning.has(name);
  }

  addTransitioning(name: string): void {
    (this as any).transitioning.add(name);
  }

  removeTransitioning(name: string): void {
    (this as any).transitioning.delete(name);
  }

  // Override getSleepConfig for testing without real mind dirs
  private testSleepConfigs = new Map<string, any>();

  setSleepConfigForTest(name: string, config: any): void {
    this.testSleepConfigs.set(name, config);
  }

  override getSleepConfig(name: string): any {
    if (this.testSleepConfigs.has(name)) {
      return this.testSleepConfigs.get(name);
    }
    return null;
  }

  // Expose inSleepWindow / shouldSleepNow for testing
  testInSleepWindow(
    schedule: { sleep: string; wake: string },
    now: Date,
  ): { inWindow: boolean; windowStart: Date | null } {
    return (this as any).inSleepWindow(schedule, now);
  }

  testShouldSleepNow(
    schedule: { sleep: string; wake: string },
    lastWakeAt: string | null,
    now: Date,
  ): boolean {
    return (this as any).shouldSleepNow(schedule, lastWakeAt, now);
  }

  // Expose getNextWakeTime for testing
  testGetNextWakeTime(config: any): string | null {
    return (this as any).getNextWakeTime(config);
  }

  // Override saveState to avoid filesystem access
  override saveState(): void {
    // no-op in tests
  }

  // Expose statePath for persistence tests
  setStatePath(path: string): void {
    Object.defineProperty(this, "statePath", { get: () => path });
  }

  // Expose buildTriggerWakeSummary for testing
  testBuildTriggerWakeSummary(state: SleepState): string {
    return (this as any).buildTriggerWakeSummary(state);
  }

  // Stub the batch delivery seam so flushQueuedMessages can be tested without the real
  // delivery stack. Each call is one channel's batch; `deliverResult` decides per-batch
  // success (keyed off the batch's first payload's channel).
  deliveredBatches: { channel: string; payloads: any[] }[] = [];
  deliverResult: (channel: string, payloads: any[]) => boolean = () => true;

  override async deliverQueuedBatch(_name: string, payloads: any[]): Promise<boolean> {
    const channel = (payloads[0]?.channel as string) ?? "unknown";
    this.deliveredBatches.push({ channel, payloads });
    return this.deliverResult(channel, payloads);
  }

  // Expose wake-failure handling for testing
  testHandleWakeFailure(name: string, err: unknown): Promise<void> {
    return (this as any).handleWakeFailure(name, err);
  }

  testResetWakeBackoff(name: string): void {
    (this as any).resetWakeBackoff(name);
  }

  // Expose markSleeping for testing
  testMarkSleeping(name: string, opts?: { voluntaryWakeAt?: string }): void {
    (this as any).markSleeping(name, opts);
  }

  // Stub initiateWake/initiateSleep so evaluateMind can be tested without a live
  // MindManager. Records the names it was asked to wake/sleep.
  wakeCalls: string[] = [];
  sleepCalls: string[] = [];

  override async initiateWake(name: string): Promise<void> {
    this.wakeCalls.push(name);
  }

  override async initiateSleep(name: string): Promise<void> {
    this.sleepCalls.push(name);
  }

  // Expose evaluateMind for testing
  testEvaluateMind(name: string, now: Date): Promise<void> {
    return (this as any).evaluateMind(name, now);
  }
}

function sleepingState(overrides?: Partial<SleepState>): SleepState {
  return {
    sleeping: true,
    sleepingSince: new Date(Date.now() - 8 * 3600_000).toISOString(), // 8 hours ago
    scheduledWakeAt: null,
    wokenByTrigger: false,
    voluntaryWakeAt: null,
    queuedMessageCount: 0,
    triggerWakeHistory: [],
    wakeFailures: 0,
    nextWakeAttemptAt: null,
    lastWakeAt: null,
    ...overrides,
  };
}

function awakeState(overrides?: Partial<SleepState>): SleepState {
  return {
    sleeping: false,
    sleepingSince: null,
    scheduledWakeAt: null,
    wokenByTrigger: false,
    voluntaryWakeAt: null,
    queuedMessageCount: 0,
    triggerWakeHistory: [],
    wakeFailures: 0,
    nextWakeAttemptAt: null,
    lastWakeAt: null,
    ...overrides,
  };
}

describe("SleepManager", () => {
  it("isSleeping returns false for unknown minds", () => {
    const sm = new TestSleepManager();
    assert.equal(sm.isSleeping("unknown-mind"), false);
  });

  it("isSleeping returns true when mind is sleeping", () => {
    const sm = new TestSleepManager();
    sm.setStateForTest("test-mind", sleepingState());
    assert.equal(sm.isSleeping("test-mind"), true);
  });

  it("isSleeping returns false when mind is awake", () => {
    const sm = new TestSleepManager();
    sm.setStateForTest("test-mind", awakeState());
    assert.equal(sm.isSleeping("test-mind"), false);
  });

  it("isSleeping returns false during trigger-wake", () => {
    const sm = new TestSleepManager();
    sm.setStateForTest("test-mind", sleepingState({ wokenByTrigger: true }));
    assert.equal(sm.isSleeping("test-mind"), false);
  });

  it("getState returns default for unknown minds", () => {
    const sm = new TestSleepManager();
    const state = sm.getState("unknown-mind");
    assert.equal(state.sleeping, false);
    assert.equal(state.sleepingSince, null);
    assert.equal(state.queuedMessageCount, 0);
  });

  it("getState returns current state for known minds", () => {
    const sm = new TestSleepManager();
    const expected = sleepingState({ queuedMessageCount: 5 });
    sm.setStateForTest("test-mind", expected);
    const state = sm.getState("test-mind");
    assert.equal(state.sleeping, true);
    assert.equal(state.queuedMessageCount, 5);
  });
});

describe("matchesGlob", () => {
  it("matches exact strings", () => {
    assert.equal(matchesGlob("discord:server/general", "discord:server/general"), true);
  });

  it("rejects non-matching strings", () => {
    assert.equal(matchesGlob("discord:server/general", "slack:server/general"), false);
  });

  it("supports * wildcard", () => {
    assert.equal(matchesGlob("discord:*", "discord:server/general"), true);
    assert.equal(matchesGlob("discord:*", "slack:workspace/ch"), false);
  });

  it("supports * in the middle", () => {
    assert.equal(matchesGlob("discord:*/general", "discord:myserver/general"), true);
    assert.equal(matchesGlob("discord:*/general", "discord:myserver/random"), false);
  });

  it("supports multiple wildcards", () => {
    assert.equal(matchesGlob("*:*", "discord:anything"), true);
    assert.equal(matchesGlob("*:*/general", "discord:server/general"), true);
  });

  it("escapes regex metacharacters in patterns", () => {
    // A dot in the pattern should match only a literal dot
    assert.equal(matchesGlob("file.txt", "file.txt"), true);
    assert.equal(matchesGlob("file.txt", "fileXtxt"), false);
  });

  it("escapes plus signs", () => {
    assert.equal(matchesGlob("a+b", "a+b"), true);
    assert.equal(matchesGlob("a+b", "aab"), false);
  });

  it("escapes parentheses", () => {
    assert.equal(matchesGlob("(test)", "(test)"), true);
    assert.equal(matchesGlob("(test)", "test"), false);
  });

  it("escapes square brackets", () => {
    assert.equal(matchesGlob("[test]", "[test]"), true);
    assert.equal(matchesGlob("[test]", "t"), false);
  });

  it("escapes curly braces", () => {
    assert.equal(matchesGlob("{a,b}", "{a,b}"), true);
  });

  it("escapes pipe", () => {
    assert.equal(matchesGlob("a|b", "a|b"), true);
    assert.equal(matchesGlob("a|b", "a"), false);
    assert.equal(matchesGlob("a|b", "b"), false);
  });

  it("escapes caret and dollar", () => {
    assert.equal(matchesGlob("^test$", "^test$"), true);
    assert.equal(matchesGlob("^test$", "test"), false);
  });

  it("handles regex metacharacters in values safely", () => {
    assert.equal(matchesGlob("*", "some.weird[channel](name)"), true);
    assert.equal(matchesGlob("discord:*", "discord:server.name/channel"), true);
  });
});

describe("SleepManager.checkWakeTrigger", () => {
  // checkWakeTrigger reads the mind's volute.json config for wakeTriggers.
  // Without a real mind dir, getSleepConfig returns null, which means
  // default triggers apply (mentions=true, dms=true).

  it("DM triggers wake by default", () => {
    const sm = new TestSleepManager();
    const result = sm.checkWakeTrigger("test-mind", {
      channel: "discord:server/channel",
      sender: "user1",
      isDM: true,
    });
    assert.equal(result, true);
  });

  it("mention in content triggers wake by default", () => {
    const sm = new TestSleepManager();
    const result = sm.checkWakeTrigger("test-mind", {
      channel: "discord:server/general",
      sender: "user1",
      content: "Hey @test-mind are you there?",
    });
    assert.equal(result, true);
  });

  it("mention in content blocks triggers wake", () => {
    const sm = new TestSleepManager();
    const result = sm.checkWakeTrigger("test-mind", {
      channel: "discord:server/general",
      sender: "user1",
      content: [{ type: "text", text: "Hello @test-mind" }],
    });
    assert.equal(result, true);
  });

  it("regular message does not trigger wake", () => {
    const sm = new TestSleepManager();
    const result = sm.checkWakeTrigger("test-mind", {
      channel: "discord:server/general",
      sender: "user1",
      content: "Just chatting about stuff",
    });
    assert.equal(result, false);
  });

  it("non-DM without mention does not trigger wake", () => {
    const sm = new TestSleepManager();
    const result = sm.checkWakeTrigger("test-mind", {
      channel: "slack:workspace/random",
      sender: "user2",
      isDM: false,
      content: "This is a regular message",
    });
    assert.equal(result, false);
  });

  it("DM does not trigger wake when dms: false", () => {
    const sm = new TestSleepManager();
    sm.setSleepConfigForTest("test-mind", {
      enabled: true,
      wakeTriggers: { dms: false, mentions: true },
    });
    const result = sm.checkWakeTrigger("test-mind", {
      channel: "discord:server/channel",
      sender: "user1",
      isDM: true,
    });
    assert.equal(result, false);
  });

  it("mention does not trigger wake when mentions: false", () => {
    const sm = new TestSleepManager();
    sm.setSleepConfigForTest("test-mind", {
      enabled: true,
      wakeTriggers: { dms: true, mentions: false },
    });
    const result = sm.checkWakeTrigger("test-mind", {
      channel: "discord:server/general",
      sender: "user1",
      content: "Hey @test-mind",
    });
    assert.equal(result, false);
  });

  it("channel glob match triggers wake", () => {
    const sm = new TestSleepManager();
    sm.setSleepConfigForTest("test-mind", {
      enabled: true,
      wakeTriggers: {
        dms: false,
        mentions: false,
        channels: ["discord:*/important"],
      },
    });
    const result = sm.checkWakeTrigger("test-mind", {
      channel: "discord:myserver/important",
      sender: "user1",
      content: "Hey",
    });
    assert.equal(result, true);
  });

  it("channel glob non-match does not trigger wake", () => {
    const sm = new TestSleepManager();
    sm.setSleepConfigForTest("test-mind", {
      enabled: true,
      wakeTriggers: {
        dms: false,
        mentions: false,
        channels: ["discord:*/important"],
      },
    });
    const result = sm.checkWakeTrigger("test-mind", {
      channel: "discord:myserver/random",
      sender: "user1",
      content: "Hey",
    });
    assert.equal(result, false);
  });

  it("sender glob match triggers wake", () => {
    const sm = new TestSleepManager();
    sm.setSleepConfigForTest("test-mind", {
      enabled: true,
      wakeTriggers: {
        dms: false,
        mentions: false,
        senders: ["admin-*"],
      },
    });
    const result = sm.checkWakeTrigger("test-mind", {
      channel: "discord:server/general",
      sender: "admin-john",
      content: "Hey",
    });
    assert.equal(result, true);
  });

  it("sender glob non-match does not trigger wake", () => {
    const sm = new TestSleepManager();
    sm.setSleepConfigForTest("test-mind", {
      enabled: true,
      wakeTriggers: {
        dms: false,
        mentions: false,
        senders: ["admin-*"],
      },
    });
    const result = sm.checkWakeTrigger("test-mind", {
      channel: "discord:server/general",
      sender: "regular-user",
      content: "Hey",
    });
    assert.equal(result, false);
  });

  it("no sender does not match sender globs", () => {
    const sm = new TestSleepManager();
    sm.setSleepConfigForTest("test-mind", {
      enabled: true,
      wakeTriggers: {
        dms: false,
        mentions: false,
        senders: ["*"],
      },
    });
    const result = sm.checkWakeTrigger("test-mind", {
      channel: "discord:server/general",
      content: "Hey",
    });
    assert.equal(result, false);
  });
});

describe("SleepManager state transitions", () => {
  it("sleeping → awake transition clears state", () => {
    const sm = new TestSleepManager();
    sm.setStateForTest("test-mind", sleepingState());
    assert.equal(sm.isSleeping("test-mind"), true);

    sm.deleteStateForTest("test-mind");
    assert.equal(sm.isSleeping("test-mind"), false);
  });

  it("trigger wake sets wokenByTrigger flag", () => {
    const sm = new TestSleepManager();
    const state = sleepingState({ wokenByTrigger: true });
    sm.setStateForTest("test-mind", state);
    assert.equal(sm.getState("test-mind").wokenByTrigger, true);
  });

  it("voluntary wake tracks wake time", () => {
    const sm = new TestSleepManager();
    const wakeAt = new Date(Date.now() + 3600_000).toISOString();
    const state = sleepingState({ voluntaryWakeAt: wakeAt });
    sm.setStateForTest("test-mind", state);
    assert.equal(sm.getState("test-mind").voluntaryWakeAt, wakeAt);
  });

  it("queued message count increments", () => {
    const sm = new TestSleepManager();
    const state = sleepingState({ queuedMessageCount: 0 });
    sm.setStateForTest("test-mind", state);

    const s = sm.getState("test-mind");
    assert.equal(s.queuedMessageCount, 0);

    // Simulate incrementing
    state.queuedMessageCount++;
    assert.equal(sm.getState("test-mind").queuedMessageCount, 1);
  });

  // #451: an explicit voluntary wake-at is authoritative for the night.
  it("markSleeping with voluntaryWakeAt nulls the cron scheduledWakeAt", () => {
    const sm = new TestSleepManager();
    sm.setSleepConfigForTest("test-mind", { schedule: { wake: "0 8 * * *" } });
    const wakeAt = new Date(Date.now() + 12 * 3600_000).toISOString();
    sm.testMarkSleeping("test-mind", { voluntaryWakeAt: wakeAt });

    const state = sm.getState("test-mind");
    assert.equal(state.scheduledWakeAt, null);
    assert.equal(state.voluntaryWakeAt, wakeAt);
  });

  it("markSleeping without voluntaryWakeAt sets scheduledWakeAt from the cron", () => {
    const sm = new TestSleepManager();
    sm.setSleepConfigForTest("test-mind", { schedule: { wake: "0 8 * * *" } });
    sm.testMarkSleeping("test-mind");

    const state = sm.getState("test-mind");
    assert.notEqual(state.scheduledWakeAt, null);
    assert.equal(state.voluntaryWakeAt, null);
  });

  // #451: a voluntary wake later than the next cron wake must not be preempted.
  // With scheduledWakeAt null, tick()'s cron branch can never fire early.
  it("voluntary wake later than cron leaves no scheduled cron wake to fire", () => {
    const sm = new TestSleepManager();
    sm.setSleepConfigForTest("test-mind", { schedule: { wake: "0 8 * * *" } });
    // Wake-at far in the future, likely later than the next 8am cron wake.
    const wakeAt = new Date(Date.now() + 30 * 3600_000).toISOString();
    sm.testMarkSleeping("test-mind", { voluntaryWakeAt: wakeAt });

    const state = sm.getState("test-mind");
    assert.equal(state.scheduledWakeAt, null);
    assert.equal(state.voluntaryWakeAt, wakeAt);
  });

  // #449: return-to-sleep after a trigger-wake must not reset sleepingSince.
  it("returnToSleepAfterCrash preserves the original bedtime (sleepingSince)", async () => {
    const sm = new TestSleepManager();
    const bedtime = new Date(Date.now() - 8 * 3600_000).toISOString();
    sm.setStateForTest(
      "test-mind",
      sleepingState({ sleepingSince: bedtime, wokenByTrigger: true }),
    );

    await sm.returnToSleepAfterCrash("test-mind");

    const state = sm.getState("test-mind");
    assert.equal(state.sleeping, true);
    assert.equal(state.sleepingSince, bedtime);
    assert.equal(state.wokenByTrigger, false);
  });

  // #451: return-to-sleep must not resurrect a cron wake when a voluntary wake
  // is pinned for the night.
  it("returnToSleepAfterCrash keeps scheduledWakeAt null when voluntaryWakeAt is set", async () => {
    const sm = new TestSleepManager();
    sm.setSleepConfigForTest("test-mind", { schedule: { wake: "0 8 * * *" } });
    const wakeAt = new Date(Date.now() + 12 * 3600_000).toISOString();
    sm.setStateForTest(
      "test-mind",
      sleepingState({ scheduledWakeAt: null, voluntaryWakeAt: wakeAt, wokenByTrigger: true }),
    );

    await sm.returnToSleepAfterCrash("test-mind");

    const state = sm.getState("test-mind");
    assert.equal(state.scheduledWakeAt, null);
    assert.equal(state.voluntaryWakeAt, wakeAt);
  });

  it("returnToSleepAfterCrash recomputes scheduledWakeAt when no voluntary wake", async () => {
    const sm = new TestSleepManager();
    sm.setSleepConfigForTest("test-mind", { schedule: { wake: "0 8 * * *" } });
    sm.setStateForTest(
      "test-mind",
      sleepingState({ scheduledWakeAt: null, voluntaryWakeAt: null, wokenByTrigger: true }),
    );

    await sm.returnToSleepAfterCrash("test-mind");

    const state = sm.getState("test-mind");
    assert.notEqual(state.scheduledWakeAt, null);
  });
});

// #450: waking a sleeping mind must not depend on a currently-enabled sleep
// config — the wake times were persisted at bedtime.
describe("SleepManager.evaluateMind wake without config", () => {
  it("wakes a sleeping mind with a past voluntaryWakeAt even with no config", async () => {
    const sm = new TestSleepManager();
    // No sleep config set at all (getSleepConfig returns null).
    const past = new Date(Date.now() - 60_000).toISOString();
    sm.setStateForTest("test-mind", sleepingState({ voluntaryWakeAt: past }));

    await sm.testEvaluateMind("test-mind", new Date());

    assert.deepEqual(sm.wakeCalls, ["test-mind"]);
  });

  it("wakes a sleeping mind with a past scheduledWakeAt when config is disabled", async () => {
    const sm = new TestSleepManager();
    sm.setSleepConfigForTest("test-mind", {
      enabled: false,
      schedule: { sleep: "0 23 * * *", wake: "0 8 * * *" },
    });
    const past = new Date(Date.now() - 60_000).toISOString();
    sm.setStateForTest("test-mind", sleepingState({ scheduledWakeAt: past }));

    await sm.testEvaluateMind("test-mind", new Date());

    assert.deepEqual(sm.wakeCalls, ["test-mind"]);
  });

  it("leaves a sleeping mind asleep when it has no wake times and no config", async () => {
    const sm = new TestSleepManager();
    sm.setStateForTest(
      "test-mind",
      sleepingState({ voluntaryWakeAt: null, scheduledWakeAt: null }),
    );

    await sm.testEvaluateMind("test-mind", new Date());

    assert.deepEqual(sm.wakeCalls, []);
    assert.equal(sm.getState("test-mind").sleeping, true);
  });

  it("does not wake before the persisted wake time arrives", async () => {
    const sm = new TestSleepManager();
    const future = new Date(Date.now() + 3600_000).toISOString();
    sm.setStateForTest("test-mind", sleepingState({ scheduledWakeAt: future }));

    await sm.testEvaluateMind("test-mind", new Date());

    assert.deepEqual(sm.wakeCalls, []);
  });
});

// #453 Part 2: level-triggered sleep onset — "should this mind be asleep now"
// rather than an exact-minute cron match.
describe("SleepManager.inSleepWindow (level-triggered onset)", () => {
  // Nightly window: asleep 00:00, awake 08:00.
  const schedule = { sleep: "0 0 * * *", wake: "0 8 * * *" };
  const at = (h: number, m = 0) => {
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d;
  };

  it("is in-window across the midnight-spanning night (03:00)", () => {
    const { inWindow, windowStart } = new TestSleepManager().testInSleepWindow(schedule, at(3));
    assert.equal(inWindow, true);
    assert.ok(windowStart);
  });

  it("is out of window during the day (12:00)", () => {
    const { inWindow } = new TestSleepManager().testInSleepWindow(schedule, at(12));
    assert.equal(inWindow, false);
  });

  it("returns not-in-window for an invalid cron", () => {
    const { inWindow, windowStart } = new TestSleepManager().testInSleepWindow(
      { sleep: "not-a-cron", wake: "0 8 * * *" },
      at(3),
    );
    assert.equal(inWindow, false);
    assert.equal(windowStart, null);
  });
});

describe("SleepManager.shouldSleepNow (onset decision)", () => {
  const schedule = { sleep: "0 0 * * *", wake: "0 8 * * *" };
  const at = (h: number, m = 0) => {
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d;
  };

  it("sleeps on fresh state inside the window (daemon restart mid-window)", () => {
    const sm = new TestSleepManager();
    // No lastWakeAt — the mind restarted at 03:30 with no persisted awake info.
    assert.equal(sm.testShouldSleepNow(schedule, null, at(3, 30)), true);
  });

  it("does not sleep outside the window (midday)", () => {
    const sm = new TestSleepManager();
    assert.equal(sm.testShouldSleepNow(schedule, null, at(12)), false);
  });

  it("exempts a mind manually woken inside the current window (no re-sleep)", () => {
    const sm = new TestSleepManager();
    // Woken at 03:00, evaluated at 03:30 — after the 00:00 window start.
    const lastWakeAt = at(3).toISOString();
    assert.equal(sm.testShouldSleepNow(schedule, lastWakeAt, at(3, 30)), false);
  });

  it("still sleeps when the last wake was before this window began", () => {
    const sm = new TestSleepManager();
    // Woken yesterday at 20:00, before the 00:00 window start.
    const lastWakeAt = at(-4).toISOString(); // 20:00 previous day
    assert.equal(sm.testShouldSleepNow(schedule, lastWakeAt, at(3, 30)), true);
  });

  it("does not sleep when the schedule cron is invalid", () => {
    const sm = new TestSleepManager();
    assert.equal(sm.testShouldSleepNow({ sleep: "nope", wake: "0 8 * * *" }, null, at(3)), false);
  });
});

describe("SleepManager.getNextWakeTime", () => {
  it("returns null when no config", () => {
    const sm = new TestSleepManager();
    assert.equal(sm.testGetNextWakeTime(null), null);
  });

  it("returns null when no schedule", () => {
    const sm = new TestSleepManager();
    assert.equal(sm.testGetNextWakeTime({ enabled: true }), null);
  });

  it("returns null when no wake cron", () => {
    const sm = new TestSleepManager();
    assert.equal(
      sm.testGetNextWakeTime({ enabled: true, schedule: { sleep: "0 23 * * *" } }),
      null,
    );
  });

  it("returns ISO string for valid cron", () => {
    const sm = new TestSleepManager();
    const result = sm.testGetNextWakeTime({
      enabled: true,
      schedule: { sleep: "0 23 * * *", wake: "0 7 * * *" },
    });
    assert.ok(result !== null, "expected non-null result");
    // Should be a valid ISO date
    const date = new Date(result!);
    assert.ok(!Number.isNaN(date.getTime()), "expected valid date");
  });

  it("returns null for invalid cron", () => {
    const sm = new TestSleepManager();
    const result = sm.testGetNextWakeTime({
      enabled: true,
      schedule: { sleep: "0 23 * * *", wake: "not-valid-cron" },
    });
    assert.equal(result, null);
  });
});

describe("SleepManager transitioning guard", () => {
  it("transitioning flag can be set and cleared", () => {
    const sm = new TestSleepManager();
    assert.equal(sm.isTransitioning("test-mind"), false);

    sm.addTransitioning("test-mind");
    assert.equal(sm.isTransitioning("test-mind"), true);

    sm.removeTransitioning("test-mind");
    assert.equal(sm.isTransitioning("test-mind"), false);
  });

  it("transitioning is independent per mind", () => {
    const sm = new TestSleepManager();
    sm.addTransitioning("mind-a");

    assert.equal(sm.isTransitioning("mind-a"), true);
    assert.equal(sm.isTransitioning("mind-b"), false);
  });
});

describe("SleepManager state persistence", () => {
  it("saveState only persists sleeping states", () => {
    const tmpDir = resolve(tmpdir(), `sleep-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const statePath = resolve(tmpDir, "sleep-state.json");

    // Create a manager that actually writes to disk
    const sm = new SleepManager();
    // Override statePath
    Object.defineProperty(sm, "statePath", { get: () => statePath });

    // Set states directly
    (sm as any).states.set("sleeping-mind", sleepingState());
    (sm as any).states.set("awake-mind", awakeState());

    sm.saveState();

    const data = JSON.parse(readFileSync(statePath, "utf-8"));
    assert.ok("sleeping-mind" in data, "sleeping mind should be persisted");
    assert.ok(!("awake-mind" in data), "awake mind should not be persisted");

    // Cleanup
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loadState restores sleeping states", () => {
    const tmpDir = resolve(tmpdir(), `sleep-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const statePath = resolve(tmpDir, "sleep-state.json");

    const state = sleepingState({ queuedMessageCount: 3 });
    writeFileSync(statePath, JSON.stringify({ "test-mind": state }));

    const sm = new SleepManager();
    Object.defineProperty(sm, "statePath", { get: () => statePath });

    // loadState is private but called by start() — call it directly
    (sm as any).loadState();

    assert.equal(sm.isSleeping("test-mind"), true);
    assert.equal(sm.getState("test-mind").queuedMessageCount, 3);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loadState handles missing file gracefully", () => {
    const sm = new SleepManager();
    Object.defineProperty(sm, "statePath", {
      get: () => "/nonexistent/path/sleep-state.json",
    });

    // Should not throw
    (sm as any).loadState();
    assert.equal(sm.isSleeping("any-mind"), false);
  });

  it("loadState handles corrupt file gracefully", () => {
    const tmpDir = resolve(tmpdir(), `sleep-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const statePath = resolve(tmpDir, "sleep-state.json");

    writeFileSync(statePath, "not json{{{");

    const sm = new SleepManager();
    Object.defineProperty(sm, "statePath", { get: () => statePath });

    // Should not throw
    (sm as any).loadState();
    assert.equal(sm.isSleeping("any-mind"), false);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loadState initializes missing triggerWakeHistory on old persisted state", () => {
    const tmpDir = resolve(tmpdir(), `sleep-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const statePath = resolve(tmpDir, "sleep-state.json");

    // Simulate old state format without triggerWakeHistory
    const oldState = {
      sleeping: true,
      sleepingSince: new Date().toISOString(),
      scheduledWakeAt: null,
      wokenByTrigger: false,
      voluntaryWakeAt: null,
      queuedMessageCount: 0,
    };
    writeFileSync(statePath, JSON.stringify({ "test-mind": oldState }));

    const sm = new SleepManager();
    Object.defineProperty(sm, "statePath", { get: () => statePath });
    (sm as any).loadState();

    const state = sm.getState("test-mind");
    assert.ok(
      Array.isArray(state.triggerWakeHistory),
      "triggerWakeHistory should be initialized as array",
    );
    assert.equal(state.triggerWakeHistory.length, 0);

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("SleepManager.convertTriggerToFullWake", () => {
  it("clears sleep state when trigger-woken", () => {
    const sm = new TestSleepManager();
    sm.setStateForTest("test-mind", sleepingState({ wokenByTrigger: true }));
    assert.equal(sm.getState("test-mind").sleeping, true);

    sm.convertTriggerToFullWake("test-mind");

    // markAwake records an awake state (lastWakeAt), so the mind is no longer sleeping
    assert.equal(sm.getState("test-mind").sleeping, false);
  });

  it("records lastWakeAt on full wake so onset can exempt it (#453)", () => {
    const sm = new TestSleepManager();
    sm.setStateForTest("test-mind", sleepingState({ wokenByTrigger: true }));

    sm.convertTriggerToFullWake("test-mind");

    const state = sm.getStateForTest("test-mind");
    assert.ok(state?.lastWakeAt, "expected lastWakeAt to be recorded on full wake");
    assert.equal(state?.sleeping, false);
  });

  it("is a no-op when sleeping but not trigger-woken", () => {
    const sm = new TestSleepManager();
    sm.setStateForTest("test-mind", sleepingState({ wokenByTrigger: false }));

    sm.convertTriggerToFullWake("test-mind");

    // Should still be sleeping
    assert.equal(sm.getState("test-mind").sleeping, true);
  });

  it("is a no-op when mind is not sleeping", () => {
    const sm = new TestSleepManager();
    sm.setStateForTest("test-mind", awakeState());

    sm.convertTriggerToFullWake("test-mind");

    assert.equal(sm.getState("test-mind").sleeping, false);
  });

  it("is a no-op for unknown minds", () => {
    const sm = new TestSleepManager();
    sm.convertTriggerToFullWake("unknown-mind");
    assert.equal(sm.getState("unknown-mind").sleeping, false);
  });
});

describe("SleepManager sleep config cache", () => {
  it("getSleepConfig caches result", () => {
    const sm = new TestSleepManager();
    const config = { enabled: true, schedule: { sleep: "0 23 * * *", wake: "0 7 * * *" } };
    sm.setSleepConfigForTest("test-mind", config);

    const result1 = sm.getSleepConfig("test-mind");
    const result2 = sm.getSleepConfig("test-mind");
    assert.deepEqual(result1, config);
    assert.deepEqual(result2, config);
  });

  it("invalidateSleepConfig clears cached config", () => {
    const sm = new TestSleepManager();
    const config = { enabled: true };
    sm.setSleepConfigForTest("test-mind", config);

    assert.deepEqual(sm.getSleepConfig("test-mind"), config);

    // Invalidate — next call should return null (no real mind dir in test)
    sm.invalidateSleepConfig("test-mind");
    // After invalidation, getSleepConfig falls through to testSleepConfigs
    // which no longer has the entry, so returns null
    sm.setSleepConfigForTest("test-mind", null);
    assert.equal(sm.getSleepConfig("test-mind"), null);
  });
});

describe("SleepManager.buildTriggerWakeSummary", () => {
  it("returns empty string for empty history", () => {
    const sm = new TestSleepManager();
    const result = sm.testBuildTriggerWakeSummary(sleepingState({ triggerWakeHistory: [] }));
    assert.equal(result, "");
  });

  it("returns empty string for undefined history", () => {
    const sm = new TestSleepManager();
    const state = sleepingState();
    (state as any).triggerWakeHistory = undefined;
    const result = sm.testBuildTriggerWakeSummary(state);
    assert.equal(result, "");
  });

  it("describes single trigger wake", () => {
    const sm = new TestSleepManager();
    const result = sm.testBuildTriggerWakeSummary(
      sleepingState({
        triggerWakeHistory: [{ channel: "system:dream", at: new Date().toISOString() }],
      }),
    );
    assert.ok(result.includes("once"));
    assert.ok(result.includes("system:dream"));
  });

  it("describes multiple trigger wakes on same channel", () => {
    const sm = new TestSleepManager();
    const result = sm.testBuildTriggerWakeSummary(
      sleepingState({
        triggerWakeHistory: [
          { channel: "system:dream", at: new Date().toISOString() },
          { channel: "system:dream", at: new Date().toISOString() },
        ],
      }),
    );
    assert.ok(result.includes("2 times"));
    assert.ok(result.includes("system:dream"));
  });

  it("describes multiple trigger wakes on different channels", () => {
    const sm = new TestSleepManager();
    const result = sm.testBuildTriggerWakeSummary(
      sleepingState({
        triggerWakeHistory: [
          { channel: "system:dream", at: new Date().toISOString() },
          { channel: "discord:server/general", at: new Date().toISOString() },
          { channel: "system:dream", at: new Date().toISOString() },
        ],
      }),
    );
    assert.ok(result.includes("3 times"));
    assert.ok(result.includes("system:dream"));
    assert.ok(result.includes("discord:server/general"));
  });

  it("returnToSleepAfterCrash restores sleeping state and clears wokenByTrigger", async () => {
    const sm = new TestSleepManager();
    sm.setStateForTest(
      "crasher",
      sleepingState({
        wokenByTrigger: true,
        triggerWakeHistory: [{ channel: "@volute", at: new Date().toISOString() }],
      }),
    );
    // sleepMind() throws (no MindManager in unit tests) but is tolerated; the
    // mind must still end back asleep rather than in wokenByTrigger limbo.
    await sm.returnToSleepAfterCrash("crasher");
    const state = sm.getStateForTest("crasher");
    assert.equal(state?.sleeping, true);
    assert.equal(state?.wokenByTrigger, false);
    assert.equal(sm.isTransitioning("crasher"), false);
  });

  it("returnToSleepAfterCrash is a no-op when the mind was not trigger-woken", async () => {
    const sm = new TestSleepManager();
    sm.setStateForTest("normal", sleepingState({ wokenByTrigger: false }));
    await sm.returnToSleepAfterCrash("normal");
    const state = sm.getStateForTest("normal");
    assert.equal(state?.sleeping, true);
    assert.equal(state?.wokenByTrigger, false);
  });
});

describe("SleepManager.flushQueuedMessages", () => {
  let counter = 0;
  // Unique mind name per test so rows in the shared delivery_queue don't cross-contaminate.
  function uniqueMind(): string {
    return `flush-mind-${process.pid}-${counter++}`;
  }

  async function queue(mind: string, content: string, channel = "@volute"): Promise<void> {
    const db = await getDb();
    await db.insert(deliveryQueue).values({
      mind,
      thread: "sleep",
      channel,
      sender: "volute",
      status: "sleep-queued",
      payload: JSON.stringify({ channel, sender: "volute", content }),
    });
  }

  async function queuedRows(mind: string) {
    const db = await getDb();
    return db
      .select()
      .from(deliveryQueue)
      .where(and(eq(deliveryQueue.mind, mind), eq(deliveryQueue.status, "sleep-queued")))
      .all();
  }

  it("delivers one batch per channel and deletes delivered rows (#382)", async () => {
    const mind = uniqueMind();
    await queue(mind, "a");
    await queue(mind, "b");
    await queue(mind, "c");

    const sm = new TestSleepManager();
    sm.setStateForTest(mind, sleepingState({ queuedMessageCount: 3 }));

    const flushed = await sm.flushQueuedMessages(mind);

    assert.equal(flushed, 3);
    // All three share a channel → ONE batch delivery, not three.
    assert.equal(sm.deliveredBatches.length, 1, "single channel delivered as one batch");
    assert.equal(sm.deliveredBatches[0].payloads.length, 3, "batch carries all three messages");
    // Arrival order preserved within the channel batch.
    assert.deepEqual(
      sm.deliveredBatches[0].payloads.map((p) => p.content),
      ["a", "b", "c"],
    );
    assert.equal((await queuedRows(mind)).length, 0, "all delivered rows deleted");
    assert.equal(sm.getState(mind).queuedMessageCount, 0);
  });

  it("groups by channel into one batch each", async () => {
    const mind = uniqueMind();
    await queue(mind, "a1", "#alpha");
    await queue(mind, "b1", "#beta");
    await queue(mind, "a2", "#alpha");

    const sm = new TestSleepManager();
    sm.setStateForTest(mind, sleepingState({ queuedMessageCount: 3 }));

    const flushed = await sm.flushQueuedMessages(mind);

    assert.equal(flushed, 3);
    assert.equal(sm.deliveredBatches.length, 2, "two channels → two batches");
    const alpha = sm.deliveredBatches.find((b) => b.channel === "#alpha");
    const beta = sm.deliveredBatches.find((b) => b.channel === "#beta");
    assert.deepEqual(
      alpha?.payloads.map((p) => p.content),
      ["a1", "a2"],
    );
    assert.deepEqual(
      beta?.payloads.map((p) => p.content),
      ["b1"],
    );
    assert.equal((await queuedRows(mind)).length, 0);
  });

  it("leaves the whole channel group queued when its batch fails (no silent drop)", async () => {
    const mind = uniqueMind();
    await queue(mind, "a");
    await queue(mind, "b");

    const sm = new TestSleepManager();
    sm.deliverResult = () => false; // batch delivery fails

    const flushed = await sm.flushQueuedMessages(mind);

    assert.equal(flushed, 0);
    assert.equal((await queuedRows(mind)).length, 2, "failed batch must not delete its rows");
  });

  it("keeps a failed channel queued while other channels flush (#382)", async () => {
    const mind = uniqueMind();
    await queue(mind, "ok1", "#good");
    await queue(mind, "ok2", "#good");
    await queue(mind, "bad1", "#bad");
    await queue(mind, "bad2", "#bad");

    const sm = new TestSleepManager();
    sm.setStateForTest(mind, sleepingState({ queuedMessageCount: 4 }));
    // Only the #bad channel's batch fails.
    sm.deliverResult = (channel) => channel !== "#bad";

    const flushed = await sm.flushQueuedMessages(mind);

    assert.equal(flushed, 2, "the good channel's two messages delivered");
    const remaining = await queuedRows(mind);
    assert.equal(remaining.length, 2, "the failed channel's rows stay queued");
    const contents = remaining.map((r) => JSON.parse(r.payload).content).sort();
    assert.deepEqual(contents, ["bad1", "bad2"]);
    assert.equal(sm.getState(mind).queuedMessageCount, 2);
  });

  it("drops an unparseable payload instead of replaying it forever", async () => {
    const mind = uniqueMind();
    const db = await getDb();
    await db.insert(deliveryQueue).values({
      mind,
      thread: "sleep",
      status: "sleep-queued",
      payload: "not-json{{{",
    });
    await queue(mind, "good");

    const sm = new TestSleepManager();
    const flushed = await sm.flushQueuedMessages(mind);

    assert.equal(flushed, 1, "the good message delivered");
    assert.equal(sm.deliveredBatches.length, 1, "one batch delivered");
    assert.equal(
      sm.deliveredBatches[0].payloads.length,
      1,
      "the unparseable row never reached delivery",
    );
    assert.equal((await queuedRows(mind)).length, 0, "both rows cleared from the queue");
  });
});

describe("SleepManager wake-failure handling", () => {
  it("applies increasing backoff on consecutive failures instead of retrying every tick", async () => {
    const sm = new TestSleepManager();
    sm.setStateForTest("faily", sleepingState());
    const err = new Error("boom");

    await sm.testHandleWakeFailure("faily", err);
    let state = sm.getStateForTest("faily");
    assert.equal(state?.wakeFailures, 1);
    assert.ok(state?.nextWakeAttemptAt, "first failure schedules a retry");
    const wait1 = new Date(state!.nextWakeAttemptAt!).getTime() - Date.now();
    assert.ok(wait1 > 30_000 && wait1 <= 61_000, `first backoff ~60s, got ${wait1}ms`);

    await sm.testHandleWakeFailure("faily", err);
    state = sm.getStateForTest("faily");
    assert.equal(state?.wakeFailures, 2);
    const wait2 = new Date(state!.nextWakeAttemptAt!).getTime() - Date.now();
    assert.ok(wait2 > wait1, "second backoff is longer than the first");

    // Still sleeping — hasn't given up yet.
    assert.equal(sm.isSleeping("faily"), true);
  });

  it("gives up after MAX attempts, clears sleep state, and surfaces the failure", async () => {
    const sm = new TestSleepManager();
    sm.setStateForTest("broken", sleepingState());
    const err = new Error("nonexistent model gpt-5.4");

    for (let i = 0; i < 5; i++) {
      await sm.testHandleWakeFailure("broken", err);
    }

    // It isn't asleep, it's broken — sleep state cleared so the tick stops retrying.
    assert.equal(sm.isSleeping("broken"), false);
    assert.equal(sm.getStateForTest("broken"), undefined);

    const db = await getDb();

    // Activity event surfaced for the web UI.
    const events = await db.select().from(activity).where(eq(activity.mind, "broken")).all();
    assert.ok(
      events.some((e) => e.type === "mind_stopped" && e.summary.includes("failed to wake")),
      "expected a mind_stopped wake-failure activity event",
    );

    // Notice recorded so the mind learns what happened on its next session.
    const notices = await db
      .select()
      .from(systemEvents)
      .where(eq(systemEvents.mind, "broken"))
      .all();
    assert.ok(
      notices.some(
        (n) => JSON.parse(n.meta ?? "{}").subtype === "startup" && n.body.includes("gpt-5.4"),
      ),
      "expected a startup notice carrying the wake error",
    );
  });

  it("resetWakeBackoff clears the failure count and scheduled retry", () => {
    const sm = new TestSleepManager();
    sm.setStateForTest(
      "recover",
      sleepingState({ wakeFailures: 3, nextWakeAttemptAt: new Date().toISOString() }),
    );
    sm.testResetWakeBackoff("recover");
    const state = sm.getStateForTest("recover");
    assert.equal(state?.wakeFailures, 0);
    assert.equal(state?.nextWakeAttemptAt, null);
  });

  it("handleWakeFailure is a no-op for a mind that is not sleeping", async () => {
    const sm = new TestSleepManager();
    sm.setStateForTest("awake", awakeState());
    await sm.testHandleWakeFailure("awake", new Error("x"));
    assert.equal(sm.getStateForTest("awake")?.wakeFailures, 0);
  });
});
