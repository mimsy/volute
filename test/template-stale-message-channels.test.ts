import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { composeTemplate } from "../packages/daemon/src/lib/template/template.js";

/**
 * Regression guard for issue #700: a stale messageChannels entry misroutes the next turn.
 *
 * The claude and pi templates track pending messages in a messageChannels map keyed by
 * message id. When the agent folds a second queued message into an already-running turn
 * (one result / agent_end for both messages), only `currentMessageId` used to be pruned —
 * the folded message's id lingered, was shifted in as the NEXT turn's id, and tagged that
 * turn's rows with the previous turn's channel. Worst case the stale entry was a system
 * event's synthetic `event:<type>:<id>` channel, and a reply to a human got filed as a
 * private reflection about the event.
 *
 * These tests drive the REAL composed template code (as `volute mind create` ships it),
 * feeding each template's stream/event consumer a scripted turn in which a second message
 * arrives mid-run and is folded. They assert the fold leaves no stale entry behind and
 * that the following turn claims its own id, not the leftover.
 */

const templatesRoot = resolvePath(fileURLToPath(import.meta.url), "../../templates");
const composed: string[] = [];

after(() => {
  for (const dir of composed) rmSync(dir, { recursive: true, force: true });
});

type MessageChannels = Map<string, { channel: string; sender?: string }>;

describe("claude template: folded messages leave no stale messageChannels entry", () => {
  let consumeStream: typeof import("../templates/claude/src/lib/stream-consumer.js")["consumeStream"];

  before(async () => {
    const dir = composeTemplate(templatesRoot, "claude").composedDir;
    composed.push(dir);
    ({ consumeStream } = await import(resolvePath(dir, "src/lib/stream-consumer.js")));
  });

  type MessageIdEntry = { id: string | undefined; seq: number };

  function newSession() {
    return {
      name: "main",
      messageIds: [] as MessageIdEntry[],
      currentMessageId: undefined as string | undefined,
      currentSeq: undefined as number | undefined,
      messageChannels: new Map() as MessageChannels,
    };
  }

  const assistant = (text: string) => ({
    type: "assistant",
    message: { usage: {}, content: [{ type: "text", text }] },
  });
  const result = () => ({
    type: "result",
    subtype: "success",
    usage: { input_tokens: 1, output_tokens: 1 },
  });

  function newCallbacks() {
    const acked: number[] = [];
    return {
      broadcast: () => {},
      onTurnEnd: () => {},
      ack: (seq: number) => acked.push(seq),
      acked,
    };
  }

  it("a message folded into the running turn is pruned with it, and the next turn claims its own id", async () => {
    const session = newSession();
    const callbacks = newCallbacks();
    session.messageIds.push({ id: "m1", seq: 1 });
    session.messageChannels.set("m1", { channel: "@alice", sender: "alice" });

    let afterTurn1: { ids: MessageIdEntry[]; channels: string[] } | undefined;
    let ackedAfterTurn1: number[] | undefined;
    let claimedInTurn2: string | undefined;

    // The generator resumes after each yielded message has been fully processed,
    // so code between yields observes/mutates session state at exact stream points.
    async function* stream() {
      yield assistant("replying to alice"); // turn 1 claims m1
      // A system event arrives mid-run — the SDK folds it into the active turn,
      // which will emit a single result for both messages.
      session.messageIds.push({ id: "m2", seq: 2 });
      session.messageChannels.set("m2", { channel: "event:schedule:42" });
      yield result(); // turn 1 done — must consume m1 AND the folded m2
      afterTurn1 = {
        ids: [...session.messageIds],
        channels: [...session.messageChannels.keys()],
      };
      ackedAfterTurn1 = [...callbacks.acked];
      session.messageIds.push({ id: "m3", seq: 3 });
      session.messageChannels.set("m3", { channel: "@bob", sender: "bob" });
      yield assistant("replying to bob"); // turn 2 must claim m3, not the stale m2
      claimedInTurn2 = session.currentMessageId;
      yield result();
    }

    await consumeStream(stream() as never, session, callbacks);

    assert.deepEqual(
      afterTurn1,
      { ids: [], channels: [] },
      "the folded message must be pruned when its turn's result arrives",
    );
    assert.equal(
      claimedInTurn2,
      "m3",
      "the next turn must be tagged with its own message, not the stale event entry",
    );
    assert.equal(session.messageChannels.size, 0);
    // Regression guard for #764: the driving message AND the folded one must both
    // be acked by the time turn 1's result is fully handled — a stranded
    // (never-acked) entry is what got replayed verbatim on the next session
    // rotation.
    assert.deepEqual(ackedAfterTurn1, [1, 2], "both m1 and the folded m2 must be acked");
  });

  it("messages queued before the turn started keep their entries — each still gets its own run", async () => {
    // Two messages queued while the agent is idle are NOT folded: the CLI runs
    // them one per run, each with its own result. Pruning must not eat the
    // second message's entry at the first result, or its turn would lose its
    // channel (and a first-of-session message its reply instructions).
    const session = newSession();
    const callbacks = newCallbacks();
    session.messageIds.push({ id: "m1", seq: 1 }, { id: "m2", seq: 2 });
    session.messageChannels.set("m1", { channel: "@alice", sender: "alice" });
    session.messageChannels.set("m2", { channel: "@bob", sender: "bob" });

    let afterRun1: { ids: MessageIdEntry[]; channels: string[] } | undefined;
    let claimedInRun2: string | undefined;

    async function* stream() {
      yield assistant("replying to alice"); // run 1 claims m1; m2 was queued pre-run
      yield result();
      afterRun1 = {
        ids: [...session.messageIds],
        channels: [...session.messageChannels.keys()],
      };
      yield assistant("replying to bob"); // run 2 claims m2
      claimedInRun2 = session.currentMessageId;
      yield result();
    }

    await consumeStream(stream() as never, session, callbacks);

    assert.deepEqual(
      afterRun1,
      { ids: [{ id: "m2", seq: 2 }], channels: ["m2"] },
      "a pre-turn queued message keeps its entry until its own run completes",
    );
    assert.equal(claimedInRun2, "m2");
    assert.equal(session.messageChannels.size, 0);
    // Each run acks only its own driving message — not the other, still-pending one.
    assert.deepEqual(callbacks.acked, [1, 2]);
  });
});

describe("pi template: folded messages leave no stale messageChannels entry", () => {
  let createEventHandler: typeof import("../templates/pi/src/lib/event-handler.js")["createEventHandler"];
  let cwd: string;

  before(async () => {
    const dir = composeTemplate(templatesRoot, "pi").composedDir;
    composed.push(dir);
    ({ createEventHandler } = await import(resolvePath(dir, "src/lib/event-handler.js")));
    cwd = mkdtempSync(join(tmpdir(), "volute-pi-stale-test-"));
    composed.push(cwd);
  });

  function setup() {
    const session = {
      name: "main",
      messageIds: [] as (string | undefined)[],
      currentMessageId: undefined as string | undefined,
      messageChannels: new Map() as MessageChannels,
    };
    const handler = createEventHandler(session, { cwd, broadcast: () => {} });
    return { session, handler };
  }

  const textDelta = (delta: string) => ({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta },
  });

  it("a message queued mid-turn is consumed with it, and the next turn claims its own id", () => {
    const { session, handler } = setup();
    session.messageIds.push("m1");
    session.messageChannels.set("m1", { channel: "@alice", sender: "alice" });

    handler({ type: "agent_start" } as never);
    handler(textDelta("replying to alice") as never);
    // A system event arrives mid-run. pi queues it as a follow-up and its agent
    // loop drains all queued prompts before emitting a final agent_end — one
    // agent_end covers both messages.
    session.messageIds.push("m2");
    session.messageChannels.set("m2", { channel: "event:schedule:42" });
    handler({ type: "agent_end", messages: [], willRetry: false } as never);

    assert.deepEqual(session.messageIds, [], "the folded message id must not linger");
    assert.equal(
      session.messageChannels.size,
      0,
      "the folded message's channel entry must be pruned with the turn",
    );
    assert.equal(session.currentMessageId, undefined);

    // Next turn: a real message must be tagged with its own channel.
    session.messageIds.push("m3");
    session.messageChannels.set("m3", { channel: "@bob", sender: "bob" });
    handler(textDelta("replying to bob") as never);
    assert.equal(
      session.currentMessageId,
      "m3",
      "the next turn must be tagged with its own message, not the stale event entry",
    );
    handler({ type: "agent_end", messages: [], willRetry: false } as never);
    assert.equal(session.messageChannels.size, 0);
  });

  it("a retry agent_end does not drain prompts the continuation has yet to run", () => {
    // On a retryable error pi emits agent_end WITHOUT draining the follow-up
    // queue, then retries the run. A follow-up queued during the failed attempt
    // has not run yet — pruning it here would strip its channel before its turn.
    const { session, handler } = setup();
    session.messageIds.push("m1");
    session.messageChannels.set("m1", { channel: "@alice", sender: "alice" });

    handler({ type: "agent_start" } as never);
    handler(textDelta("half a reply") as never);
    session.messageIds.push("m2");
    session.messageChannels.set("m2", { channel: "@bob", sender: "bob" });
    handler({ type: "agent_end", messages: [], willRetry: true } as never);

    assert.deepEqual(session.messageIds, ["m2"], "the queued follow-up survives the retry");
    assert.ok(session.messageChannels.has("m2"), "and keeps its channel entry");

    // The retried run consumes the follow-up and ends for real.
    handler(textDelta("replying to bob") as never);
    assert.equal(session.currentMessageId, "m2");
    handler({ type: "agent_end", messages: [], willRetry: false } as never);
    assert.equal(session.messageChannels.size, 0);
  });
});
