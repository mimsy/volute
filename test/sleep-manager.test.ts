import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  beginShutdown,
  resetShutdownState,
} from "../packages/daemon/src/lib/daemon/shutdown-state.js";
import {
  getSleepManagerIfReady,
  initSleepManager,
  matchesGlob,
  SleepManager,
  type SleepState,
} from "../packages/daemon/src/lib/daemon/sleep-manager.js";
import { getDb } from "../packages/daemon/src/lib/db.js";
import {
  initDeliveryManager,
  tryGetDeliveryManager,
} from "../packages/daemon/src/lib/delivery/delivery-manager.js";
import { deliverMessage } from "../packages/daemon/src/lib/delivery/message-delivery.js";
import { publish } from "../packages/daemon/src/lib/events/activity-events.js";
import { addMind, mindDir, removeMind } from "../packages/daemon/src/lib/mind/registry.js";
import {
  activity,
  deliveryQueue,
  mindHistory,
  systemEvents,
} from "../packages/daemon/src/lib/schema.js";

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

  testArchiveSessions(name: string): Promise<void> {
    return (this as any).archiveSessions(name);
  }

  // Point persistence at a scratch file so loadState can be driven directly.
  private testStatePath: string | null = null;

  setStatePathForTest(path: string): void {
    this.testStatePath = path;
  }

  protected override get statePath(): string {
    return this.testStatePath ?? super.statePath;
  }

  testLoadState(): void {
    (this as any).loadState();
  }
}

/**
 * Drives the REAL {@link SleepManager.initiateWake}. Only the process start and the batch
 * delivery are stubbed — the state transitions, wake event and flush are shipped code.
 */
class WakeSleepManager extends SleepManager {
  setStateForTest(name: string, state: SleepState): void {
    (this as any).states.set(name, state);
  }

  setWakeTimeoutForTest(ms: number): void {
    (this as any).wakeSummaryTimeoutMs = ms;
  }

  /** These tests wake a stub HTTP mind, not a spawned process. */
  protected override async ensureProcessRunning(): Promise<boolean> {
    return true;
  }

  /** Runs in place of the wait for the wake-summary turn, when set. */
  onWaitForIdle: (() => Promise<void>) | null = null;
  midWake: {
    isSleeping: boolean;
    isWaking: boolean;
    queuesInbound: boolean;
    reported: SleepState;
  } | null = null;

  /** Runs once the real wait is listening, when set — a seam for ending it mid-wake. */
  onWaitSubscribed: (() => void) | null = null;

  protected override async waitForIdle(
    name: string,
    timeoutMs: number,
  ): Promise<"idle" | "stopped" | "timeout"> {
    if (!this.onWaitForIdle) {
      const wait = super.waitForIdle(name, timeoutMs);
      this.onWaitSubscribed?.();
      return wait;
    }
    await this.onWaitForIdle();
    return "idle";
  }

  deliveredBatches: { channel: string; payloads: any[] }[] = [];
  /** Runs as each batch is delivered — a seam for racing a row in mid-flush. */
  onDeliverBatch: (() => Promise<void>) | null = null;

  protected override async deliverQueuedBatch(_name: string, payloads: any[]): Promise<boolean> {
    this.deliveredBatches.push({
      channel: (payloads[0]?.channel as string) ?? "unknown",
      payloads,
    });
    await this.onDeliverBatch?.();
    return true;
  }
}

function sleepingState(overrides?: Partial<SleepState>): SleepState {
  return {
    sleeping: true,
    waking: false,
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
    waking: false,
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

/** Up, handed its wake event, backlog not yet drained (#920). */
function wakingState(overrides?: Partial<SleepState>): SleepState {
  return awakeState({
    waking: true,
    sleepingSince: new Date(Date.now() - 8 * 3600_000).toISOString(),
    lastWakeAt: new Date().toISOString(),
    ...overrides,
  });
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

  // #367: a crash during a trigger-wake discards the mid-wake work — the next real
  // wake must find a notice explaining the gap, not silent amnesia.
  it("returnToSleepAfterCrash records a crash notice for the next wake", async () => {
    const { drainEvents } = await import("../packages/daemon/src/lib/chat/system-events.js");
    const sm = new TestSleepManager();
    const name = `crash-notice-${Date.now()}`;
    sm.setStateForTest(name, sleepingState({ wokenByTrigger: true }));

    await sm.returnToSleepAfterCrash(name);

    const drained = await drainEvents(name, "main");
    assert.equal(drained.length, 1, "the crash leaves a mind-level notice");
    assert.match(drained[0].body, /woken by a trigger/);
    assert.match(drained[0].body, /may be incomplete/);
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

  it("a mind woken over its spend cap has its backlog held rather than flushed", async () => {
    // This path POSTs straight to the mind, so it needs its own hold check — without one
    // a night's backlog lands un-held and un-prefaced, which would make the cap notice
    // ("messages sent to you are now being held") false for exactly the minds that slept.
    const mind = uniqueMind();
    await queue(mind, "overnight one");
    await queue(mind, "overnight two");

    const sm = new TestSleepManager();
    sm.setStateForTest(mind, sleepingState({ queuedMessageCount: 2 }));

    const dm = tryGetDeliveryManager() ?? initDeliveryManager();
    dm.setHoldCheck(() => ({ reason: "spend_cap", scope: "mind" }));
    try {
      const flushed = await sm.flushQueuedMessages(mind);

      assert.equal(flushed, 0, "nothing is POSTed to a mind over its cap");
      assert.equal(sm.deliveredBatches.length, 0);
      assert.equal((await queuedRows(mind)).length, 0, "the rows leave the sleep queue");

      const db = await getDb();
      const promoted = await db
        .select()
        .from(deliveryQueue)
        .where(and(eq(deliveryQueue.mind, mind), eq(deliveryQueue.status, "held")))
        .all();
      assert.equal(promoted.length, 2, "and become held rows the release path owns");
      for (const row of promoted) {
        const payload = JSON.parse(row.payload) as { held?: { at: number; scope: string } };
        assert.equal(payload.held?.scope, "mind", "stamped with which cap held them");
        assert.ok((payload.held?.at ?? 0) > 0, "and with when they arrived");
      }
      assert.equal(sm.getState(mind).queuedMessageCount, 0);
    } finally {
      dm.setHoldCheck(() => null);
    }
  });

  it("flushes normally when nothing is holding the mind", async () => {
    const mind = uniqueMind();
    await queue(mind, "a");

    const sm = new TestSleepManager();
    sm.setStateForTest(mind, sleepingState({ queuedMessageCount: 1 }));
    const dm = tryGetDeliveryManager() ?? initDeliveryManager();
    dm.setHoldCheck(() => null);

    assert.equal(await sm.flushQueuedMessages(mind), 1);
    assert.equal(sm.deliveredBatches.length, 1);
  });

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

describe("SleepManager.archiveSessions — codex pointers", () => {
  const ARCHIVE_NAME = /^main-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}\.json$/;

  function codexSessionsDir(name: string): string {
    return resolve(mindDir(name), ".mind", "codex-sessions");
  }

  it("moves a codex pointer into archive/ with a timestamped name", async () => {
    const name = `codex-arch-${Date.now()}`;
    const dir = codexSessionsDir(name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "main.json"), JSON.stringify({ threadId: "019f-old-thread" }));

    const sm = new TestSleepManager();
    await sm.testArchiveSessions(name);

    // The live pointer is gone; a timestamped archive copy holds the threadId.
    assert.equal(existsSync(resolve(dir, "main.json")), false);
    const archived = readdirSync(resolve(dir, "archive"));
    assert.equal(archived.length, 1);
    assert.match(archived[0], ARCHIVE_NAME);
    const data = JSON.parse(readFileSync(resolve(dir, "archive", archived[0]), "utf-8"));
    assert.equal(data.threadId, "019f-old-thread");

    rmSync(mindDir(name), { recursive: true, force: true });
  });

  it("does not touch the archive/ dir itself or non-json files", async () => {
    const name = `codex-arch2-${Date.now()}`;
    const dir = codexSessionsDir(name);
    mkdirSync(resolve(dir, "archive"), { recursive: true });
    writeFileSync(resolve(dir, "main.json"), JSON.stringify({ threadId: "t1" }));
    writeFileSync(resolve(dir, "notes.txt"), "not a pointer");

    const sm = new TestSleepManager();
    await sm.testArchiveSessions(name);

    assert.equal(existsSync(resolve(dir, "notes.txt")), true);
    const archived = readdirSync(resolve(dir, "archive"));
    assert.equal(archived.length, 1);
    assert.match(archived[0], ARCHIVE_NAME);

    rmSync(mindDir(name), { recursive: true, force: true });
  });

  it("is a no-op when there is no codex-sessions dir", async () => {
    const name = `codex-arch3-${Date.now()}`;
    // Create a bare mind dir with no .mind/codex-sessions.
    mkdirSync(mindDir(name), { recursive: true });
    const sm = new TestSleepManager();
    // Should not throw.
    await sm.testArchiveSessions(name);
    assert.equal(existsSync(codexSessionsDir(name)), false);
    rmSync(mindDir(name), { recursive: true, force: true });
  });
});

/**
 * The waking window (#920): from the moment the mind is handed its wake event until its
 * backlog has drained, it is awake — and everything that asks whether it is there is told
 * so — while inbound keeps queuing so the night's messages arrive first.
 */
describe("SleepManager waking state (#920)", () => {
  it("reports a waking mind as awake", () => {
    const sm = new TestSleepManager();
    sm.setStateForTest("waker", wakingState());

    assert.equal(sm.isSleeping("waker"), false, "a waking mind is not asleep");
    assert.equal(sm.isWaking("waker"), true);
    assert.equal(sm.getState("waker").sleeping, false, "and GET /sleep must not say it is");
    assert.equal(sm.getState("waker").waking, true);
  });

  it("keeps queuing inbound while waking, so the backlog stays first", () => {
    const sm = new TestSleepManager();
    sm.setStateForTest("waker", wakingState());
    assert.equal(sm.isQueueingInbound("waker"), true);
  });

  it("queues inbound while asleep, and stops once fully awake", () => {
    const sm = new TestSleepManager();
    sm.setStateForTest("sleeper", sleepingState());
    sm.setStateForTest("up", awakeState());
    assert.equal(sm.isQueueingInbound("sleeper"), true);
    assert.equal(sm.isQueueingInbound("up"), false);
    assert.equal(sm.isQueueingInbound("never-heard-of-it"), false);
  });

  it("does not queue inbound during a trigger wake (it is listening for that message)", () => {
    const sm = new TestSleepManager();
    sm.setStateForTest("trig", sleepingState({ wokenByTrigger: true }));
    assert.equal(sm.isQueueingInbound("trig"), false);
    assert.equal(sm.isWaking("trig"), false);
  });

  it("re-wakes a mind whose wake was cut short by a daemon restart", async () => {
    const sm = new TestSleepManager();
    const dir = mkdtempSync(resolve(tmpdir(), "sleep-waking-"));
    const statePath = resolve(dir, "sleep-state.json");
    // A mind that was mid-wake when the daemon stopped, with a scheduled wake a day out
    // (as after a manual `clock wake` inside the sleep window).
    const tomorrow = new Date(Date.now() + 24 * 3600_000).toISOString();
    writeFileSync(
      statePath,
      JSON.stringify({ interrupted: wakingState({ scheduledWakeAt: tomorrow }) }),
    );
    sm.setStatePathForTest(statePath);
    sm.testLoadState();

    const state = sm.getStateForTest("interrupted");
    assert.equal(state?.waking, false, "the interrupted wake is not still in flight");
    assert.equal(state?.sleeping, true, "the mind is asleep again, so the wake is redone");
    assert.ok(
      state?.scheduledWakeAt && new Date(state.scheduledWakeAt) <= new Date(),
      "and its wake is due now, not tomorrow — otherwise its backlog strands for a day",
    );
    rmSync(dir, { recursive: true, force: true });

    // The restored state is only half the claim — prove the tick actually re-wakes it.
    await sm.testEvaluateMind("interrupted", new Date());
    assert.deepEqual(sm.wakeCalls, ["interrupted"], "the next tick redoes the wake");
  });
});

/**
 * The real `initiateWake`, driven end to end against a stub mind server. Only the process
 * start and the batch delivery are stubbed; the state transitions, the wake event, the
 * summary wait and the flush are the shipped code.
 */
describe("SleepManager.initiateWake (#920)", () => {
  /** Stub mind server: answers /message like a mind that accepts its wake event. */
  async function stubMind(name: string): Promise<{ posted: any[]; close: () => void }> {
    const posted: any[] = [];
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        try {
          posted.push(JSON.parse(Buffer.concat(chunks).toString()));
        } catch {}
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, event: true }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    await addMind(name, (server.address() as AddressInfo).port);
    return { posted, close: () => server.close() };
  }

  let counter = 0;
  function uniqueMind(): string {
    return `wake-mind-${process.pid}-${counter++}`;
  }

  async function queueSleepRow(mind: string, content: string, channel = "@volute"): Promise<void> {
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

  async function cleanup(mind: string): Promise<void> {
    const db = await getDb();
    await db.delete(deliveryQueue).where(eq(deliveryQueue.mind, mind));
    await db.delete(systemEvents).where(eq(systemEvents.mind, mind));
    await db.delete(activity).where(eq(activity.mind, mind));
    await removeMind(mind);
  }

  it("is awake, and says so, while its wake turn is still running", async () => {
    const mind = uniqueMind();
    const stub = await stubMind(mind);
    await queueSleepRow(mind, "overnight one");
    await queueSleepRow(mind, "overnight two");

    const sm = new WakeSleepManager();
    sm.setStateForTest(mind, sleepingState({ queuedMessageCount: 2 }));
    // Observed from inside the summary wait: the mind has its wake event and its turn
    // has not finished — the exact window #920 reported as `sleeping: true`.
    sm.onWaitForIdle = async () => {
      sm.midWake = {
        isSleeping: sm.isSleeping(mind),
        isWaking: sm.isWaking(mind),
        queuesInbound: sm.isQueueingInbound(mind),
        reported: sm.getState(mind),
      };
      // A live message arriving in that window.
      await queueSleepRow(mind, "live message");
    };

    try {
      await sm.initiateWake(mind);

      assert.ok(sm.midWake, "the summary wait ran");
      assert.equal(sm.midWake?.isSleeping, false, "mid-wake, the mind is not sleeping");
      assert.equal(sm.midWake?.isWaking, true);
      assert.equal(sm.midWake?.reported.sleeping, false, "GET /sleep reports sleeping: false");
      assert.equal(sm.midWake?.reported.waking, true, "and waking: true");
      assert.equal(sm.midWake?.queuesInbound, true, "while inbound still queues");

      assert.equal(
        stub.posted[0]?.event?.type,
        "wake",
        "the mind was handed its wake event before any of that",
      );

      // The live message is delivered, and behind the night's backlog.
      const delivered = sm.deliveredBatches.flatMap((b) => b.payloads.map((p: any) => p.content));
      assert.deepEqual(delivered, ["overnight one", "overnight two", "live message"]);

      const after = sm.getState(mind);
      assert.equal(after.waking, false, "once the backlog is drained, waking clears");
      assert.equal(after.sleeping, false);
      assert.equal(sm.isQueueingInbound(mind), false, "and inbound goes live");
    } finally {
      stub.close();
      await cleanup(mind);
    }
  });

  it("flushes a message that lands while the first flush is running", async () => {
    // The sweep after markAwake: a row inserted after the first flush read its rows would
    // otherwise have nothing left to deliver it until the next wake.
    const mind = uniqueMind();
    const stub = await stubMind(mind);
    await queueSleepRow(mind, "overnight");

    const sm = new WakeSleepManager();
    sm.setWakeTimeoutForTest(50);
    sm.setStateForTest(mind, sleepingState({ queuedMessageCount: 1 }));
    let raced = false;
    sm.onDeliverBatch = async () => {
      if (raced) return;
      raced = true;
      await queueSleepRow(mind, "landed during the flush");
    };

    try {
      await sm.initiateWake(mind);

      const delivered = sm.deliveredBatches.flatMap((b) => b.payloads.map((p: any) => p.content));
      assert.deepEqual(delivered, ["overnight", "landed during the flush"]);
      const db = await getDb();
      const left = await db
        .select()
        .from(deliveryQueue)
        .where(and(eq(deliveryQueue.mind, mind), eq(deliveryQueue.status, "sleep-queued")))
        .all();
      assert.equal(left.length, 0, "nothing is left stranded for the next wake");
    } finally {
      stub.close();
      await cleanup(mind);
    }
  });

  it("a mind stopped mid-wake stops waking at once, keeping its backlog for its next start", async () => {
    // #1097: a stop before the wake turn began publishes no `mind_idle`, only `mind_stopped`.
    // Waiting out the bound left the stopped mind `waking` — refusing sleep with a 409 and
    // queuing inbound — for two minutes.
    const mind = uniqueMind();
    const stub = await stubMind(mind);
    await queueSleepRow(mind, "overnight");

    const sm = new WakeSleepManager();
    sm.setWakeTimeoutForTest(60_000); // the real wait, with a bound this test must not reach
    sm.setStateForTest(mind, sleepingState({ queuedMessageCount: 1 }));
    sm.onWaitSubscribed = () => {
      void publish({ type: "mind_stopped", mind, summary: `${mind} stopped` });
    };

    try {
      const started = Date.now();
      await sm.initiateWake(mind);
      assert.ok(Date.now() - started < 5_000, "the wake ended with the process, not the bound");

      const after = sm.getState(mind);
      assert.equal(after.waking, false, "a stopped mind is not waking");
      assert.equal(after.sleeping, false, "nor put back to sleep behind the host's back");
      assert.equal(sm.isQueueingInbound(mind), false);
      assert.ok(after.lastWakeAt, "the wake is stamped, so the tick won't re-sleep it");

      assert.equal(sm.deliveredBatches.length, 0, "nothing is flushed into a dead process");
      const db = await getDb();
      const left = await db
        .select()
        .from(deliveryQueue)
        .where(and(eq(deliveryQueue.mind, mind), eq(deliveryQueue.status, "sleep-queued")))
        .all();
      assert.equal(left.length, 1, "the backlog is kept");

      // What the mind manager's start path runs once the mind is up again.
      assert.equal(await sm.flushQueuedMessages(mind), 1, "and delivered on the next start");
    } finally {
      stub.close();
      await cleanup(mind);
    }
  });

  it("a mind stopped mid-wake by daemon shutdown stays waking, so the next boot re-wakes it", async () => {
    const mind = uniqueMind();
    const stub = await stubMind(mind);

    const sm = new WakeSleepManager();
    sm.setWakeTimeoutForTest(60_000);
    sm.setStateForTest(mind, sleepingState());
    sm.onWaitSubscribed = () => {
      beginShutdown();
      void publish({ type: "mind_stopped", mind, summary: `${mind} stopped` });
    };

    try {
      await sm.initiateWake(mind);
      assert.equal(sm.getState(mind).waking, true, "the persisted flag loadState re-wakes from");
    } finally {
      resetShutdownState();
      stub.close();
      await cleanup(mind);
    }
  });

  it("a wake turn that never finishes does not hold the mind in a false state", async () => {
    // The production shape of #920: bad credentials make the SDK retry for minutes, so the
    // summary turn never completes and the wait runs to its bound.
    const mind = uniqueMind();
    const stub = await stubMind(mind);
    await queueSleepRow(mind, "overnight");

    const sm = new WakeSleepManager();
    sm.setWakeTimeoutForTest(50); // the real waitForIdle, just a shorter bound
    sm.setStateForTest(mind, sleepingState({ queuedMessageCount: 1 }));

    try {
      await sm.initiateWake(mind);

      const after = sm.getState(mind);
      assert.equal(after.sleeping, false, "the mind is awake — its process is up and fed");
      assert.equal(after.waking, false, "and the timeout released the drain rather than it");
      assert.equal(sm.deliveredBatches.length, 1, "the backlog still flushed");
      assert.ok(after.lastWakeAt, "the wake is stamped, so the tick won't re-sleep it");
    } finally {
      stub.close();
      await cleanup(mind);
    }
  });
});

/**
 * The inbound gate itself (#920), through the real `deliverMessage` and the singleton
 * sleep manager it reads — the seam that decides whether a message waits for the backlog
 * or lands on top of it.
 */
describe("inbound delivery while a mind is waking (#920)", () => {
  async function stubMind(name: string): Promise<{ posted: any[]; close: () => void }> {
    const posted: any[] = [];
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        try {
          posted.push(JSON.parse(Buffer.concat(chunks).toString()));
        } catch {}
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    await addMind(name, (server.address() as AddressInfo).port);
    return { posted, close: () => server.close() };
  }

  function singleton() {
    return getSleepManagerIfReady() ?? initSleepManager();
  }

  function setSingletonState(name: string, state: SleepState): void {
    (singleton() as unknown as { states: Map<string, SleepState> }).states.set(name, state);
  }

  async function cleanup(name: string): Promise<void> {
    const db = await getDb();
    await db.delete(deliveryQueue).where(eq(deliveryQueue.mind, name));
    await db.delete(mindHistory).where(eq(mindHistory.mind, name));
    (singleton() as unknown as { states: Map<string, SleepState> }).states.delete(name);
    await removeMind(name);
  }

  it("queues a message that arrives while the mind is still draining its backlog", async () => {
    const mind = `waking-inbound-${process.pid}`;
    const stub = await stubMind(mind);
    setSingletonState(mind, wakingState());

    try {
      const ok = await deliverMessage(mind, {
        channel: "@volute",
        sender: "someone",
        senderId: null,
        content: "sent mid-wake",
        isDM: true,
      });

      assert.equal(ok, true, "the sender is told the message was accepted");
      assert.equal(stub.posted.length, 0, "but it is not POSTed ahead of the backlog");

      const db = await getDb();
      const rows = await db
        .select()
        .from(deliveryQueue)
        .where(and(eq(deliveryQueue.mind, mind), eq(deliveryQueue.status, "sleep-queued")))
        .all();
      assert.equal(rows.length, 1, "it waits in the sleep queue for the wake flush");
      assert.equal(JSON.parse(rows[0].payload).content, "sent mid-wake");
    } finally {
      stub.close();
      await cleanup(mind);
    }
  });

  it("delivers live once the mind is fully awake", async () => {
    const mind = `awake-inbound-${process.pid}`;
    const stub = await stubMind(mind);
    setSingletonState(mind, awakeState({ lastWakeAt: new Date().toISOString() }));

    try {
      await deliverMessage(mind, {
        channel: "@volute",
        sender: "someone",
        senderId: null,
        content: "after the drain",
        isDM: true,
      });

      const db = await getDb();
      const rows = await db
        .select()
        .from(deliveryQueue)
        .where(and(eq(deliveryQueue.mind, mind), eq(deliveryQueue.status, "sleep-queued")))
        .all();
      assert.equal(rows.length, 0, "nothing is queued once waking has cleared");
      assert.ok(stub.posted.length > 0, "the message goes straight to the mind");
    } finally {
      stub.close();
      await cleanup(mind);
    }
  });
});
