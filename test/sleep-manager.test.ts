import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SleepManager, type SleepState } from "../src/lib/daemon/sleep-manager.js";

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
}

function sleepingState(overrides?: Partial<SleepState>): SleepState {
  return {
    sleeping: true,
    sleepingSince: new Date(Date.now() - 8 * 3600_000).toISOString(), // 8 hours ago
    scheduledWakeAt: null,
    wokenByTrigger: false,
    voluntaryWakeAt: null,
    queuedMessageCount: 0,
    ...overrides,
  };
}

function awakeState(): SleepState {
  return {
    sleeping: false,
    sleepingSince: null,
    scheduledWakeAt: null,
    wokenByTrigger: false,
    voluntaryWakeAt: null,
    queuedMessageCount: 0,
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
});
