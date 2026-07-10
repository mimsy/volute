import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  type DispatchOptions,
  dispatchPrompt,
  isAlreadyProcessingError,
  type PromptTarget,
} from "../templates/pi/src/lib/dispatch.js";

const ALREADY_PROCESSING =
  "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.";

const IMAGE = { type: "image", data: "abc", mimeType: "image/png" } as const;

/**
 * Models pi's AgentSession closely enough to reproduce the burst-delivery race:
 * a fresh (non-streaming) prompt only flips `isStreaming` after an async tick, so
 * two prompts sent in the same tick both observe `isStreaming === false` and race.
 * The loser is rejected with "agent is already processing", exactly like pi.
 */
class FakeAgentSession implements PromptTarget {
  streaming = false;
  turns: string[] = []; // fresh prompts that started a turn
  queued: string[] = []; // messages queued via steer/followUp
  calls: { text: string; options?: DispatchOptions }[] = [];

  get isStreaming(): boolean {
    return this.streaming;
  }

  async prompt(text: string, options?: DispatchOptions): Promise<void> {
    this.calls.push({ text, options });
    if (options?.streamingBehavior) {
      this.queued.push(text);
      return;
    }
    // Async gap before streaming flips on — this is the race window.
    await Promise.resolve();
    if (this.streaming) {
      throw new Error(ALREADY_PROCESSING);
    }
    this.streaming = true;
    this.turns.push(text);
  }
}

describe("pi template dispatchPrompt", () => {
  it("sends a fresh prompt when the agent is idle", async () => {
    const agent = new FakeAgentSession();
    let interrupts = 0;
    await dispatchPrompt(agent, "hello", {}, false, () => {
      interrupts++;
    });
    assert.deepEqual(agent.turns, ["hello"]);
    assert.deepEqual(agent.queued, []);
    assert.equal(interrupts, 0);
  });

  it("survives a two-message burst and delivers both", async () => {
    const agent = new FakeAgentSession();
    const noop = () => {};

    // Two messages dispatched in the same tick: both observe isStreaming === false.
    const p1 = dispatchPrompt(agent, "first", {}, false, noop);
    const p2 = dispatchPrompt(agent, "second", {}, false, noop);

    // The core regression: neither promise rejects (no unhandled rejection to crash
    // the mind server), and both messages land — one as a turn, one queued.
    await assert.doesNotReject(Promise.all([p1, p2]));
    assert.equal(agent.turns.length, 1, "exactly one message won the race");
    assert.equal(agent.queued.length, 1, "the loser was re-routed as a follow-up");
    assert.deepEqual([...agent.turns, ...agent.queued].sort(), ["first", "second"]);
  });

  it("carries images through the race-loser follow-up re-route", async () => {
    const agent = new FakeAgentSession();
    const noop = () => {};
    const p1 = dispatchPrompt(agent, "first", {}, false, noop);
    const p2 = dispatchPrompt(agent, "second", { images: [IMAGE] }, false, noop);
    await Promise.all([p1, p2]);
    const second = agent.calls.filter((c) => c.text === "second").at(-1);
    assert.deepEqual(second?.options?.images, [IMAGE], "images survive the re-route");
  });

  it("queues a follow-up when the agent is already streaming", async () => {
    const agent = new FakeAgentSession();
    agent.streaming = true;
    let interrupts = 0;
    await dispatchPrompt(agent, "later", { images: [IMAGE] }, false, () => {
      interrupts++;
    });
    assert.deepEqual(agent.turns, []);
    assert.deepEqual(agent.queued, ["later"]);
    assert.equal(interrupts, 0, "no interrupt without the interrupt flag");
    assert.deepEqual(agent.calls[0]?.options?.images, [IMAGE], "images pass through");
  });

  it("steers and interrupts (in that order) when interrupt is set mid-turn", async () => {
    const agent = new FakeAgentSession();
    agent.streaming = true;
    const order: string[] = [];
    const origPrompt = agent.prompt.bind(agent);
    agent.prompt = async (text, options) => {
      order.push(`prompt:${options?.streamingBehavior}`);
      return origPrompt(text, options);
    };
    await dispatchPrompt(agent, "urgent", { images: [IMAGE] }, true, () => {
      order.push("interrupt");
    });
    assert.deepEqual(agent.queued, ["urgent"]);
    assert.deepEqual(order, ["interrupt", "prompt:steer"], "interrupt fires before the steer");
    assert.deepEqual(agent.calls[0]?.options?.images, [IMAGE], "images pass through steer");
  });

  it("sends a fresh prompt (no interrupt) when interrupt is set but the agent is idle", async () => {
    const agent = new FakeAgentSession();
    let interrupts = 0;
    await dispatchPrompt(agent, "hello", {}, true, () => {
      interrupts++;
    });
    assert.deepEqual(agent.turns, ["hello"]);
    assert.equal(interrupts, 0, "interrupt only applies mid-stream");
  });

  it("rethrows errors that are not the already-processing race", async () => {
    const agent: PromptTarget = {
      isStreaming: false,
      async prompt() {
        throw new Error("model authentication failed");
      },
    };
    await assert.rejects(
      dispatchPrompt(agent, "x", {}, false, () => {}),
      /model authentication failed/,
    );
  });

  it("recognizes the pi already-processing error message", () => {
    assert.equal(isAlreadyProcessingError(new Error(ALREADY_PROCESSING)), true);
    assert.equal(isAlreadyProcessingError(new Error("something else")), false);
    assert.equal(isAlreadyProcessingError("not an error"), false);
  });

  it("matches the error message actually thrown by the installed pi-coding-agent", () => {
    // isAlreadyProcessingError matches on message text — pi exports no error class
    // for this case. Guard against silent drift: find the message pi really throws
    // in the installed package and assert our matcher still recognizes it. If a pi
    // upgrade rewords the error, this fails instead of the crash quietly returning.
    // The package only exports its root, so resolve the entry and walk to the file.
    const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const source = readFileSync(resolvePath(entry, "../core/agent-session.js"), "utf-8");
    const match = source.match(/throw new Error\("(Agent is already processing[^"]*)"\)/);
    assert.ok(match, "pi's already-processing throw not found — did the error move or reword?");
    assert.equal(isAlreadyProcessingError(new Error(match[1])), true);
    assert.equal(match[1], ALREADY_PROCESSING, "FakeAgentSession message drifted from real pi");
  });
});
