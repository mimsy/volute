import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMessageChannel } from "../templates/claude/src/lib/message-channel.js";

function msg(text: string) {
  return {
    type: "user" as const,
    session_id: "",
    message: { role: "user" as const, content: [{ type: "text" as const, text }] },
    parent_tool_use_id: null,
  };
}

function text(m: { message: { content: unknown[] } }): string {
  return (m.message.content[0] as { text: string }).text;
}

describe("createMessageChannel", () => {
  it("push then iterate yields messages in order", async () => {
    const ch = createMessageChannel();
    ch.push(msg("a"));
    ch.push(msg("b"));

    const results: string[] = [];
    const iter = ch.iterable[Symbol.asyncIterator]();
    const r1 = await iter.next();
    const r2 = await iter.next();
    assert.equal(r1.done, false);
    assert.equal(r2.done, false);
    results.push((r1.value.message.content[0] as any).text);
    results.push((r2.value.message.content[0] as any).text);
    assert.deepEqual(results, ["a", "b"]);
  });

  it("iterate then push resolves waiting consumer", async () => {
    const ch = createMessageChannel();
    const iter = ch.iterable[Symbol.asyncIterator]();

    // Start waiting before any message is pushed
    const promise = iter.next();
    ch.push(msg("delayed"));

    const result = await promise;
    assert.equal(result.done, false);
    assert.equal((result.value.message.content[0] as any).text, "delayed");
  });

  it("push returns a monotonically increasing seq, the message's identity", () => {
    const ch = createMessageChannel();
    const s1 = ch.push(msg("a"));
    const s2 = ch.push(msg("b"));
    const s3 = ch.push(msg("c"));
    assert.equal(typeof s1, "number");
    assert.ok(s2 > s1);
    assert.ok(s3 > s2);
  });

  describe("recover()", () => {
    it("returns all queued messages (with seq) and empties the queue", async () => {
      const ch = createMessageChannel();
      ch.push(msg("x"));
      ch.push(msg("y"));
      ch.push(msg("z"));

      const recovered = ch.recover();
      assert.deepEqual(
        recovered.map((e) => text(e.msg)),
        ["x", "y", "z"],
      );
      for (const e of recovered) assert.equal(typeof e.seq, "number");

      // Queue should now be empty — next push goes to a fresh queue
      ch.push(msg("after"));
      const iter = ch.iterable[Symbol.asyncIterator]();
      const r = await iter.next();
      assert.equal((r.value.message.content[0] as any).text, "after");
    });

    it("returns empty array when nothing is queued or in flight", () => {
      const ch = createMessageChannel();
      assert.deepEqual(ch.recover(), []);
    });

    it("messages pushed after recover are not affected", async () => {
      const ch = createMessageChannel();
      ch.push(msg("before"));
      ch.recover();

      ch.push(msg("after1"));
      ch.push(msg("after2"));
      const recovered2 = ch.recover();
      assert.deepEqual(
        recovered2.map((e) => text(e.msg)),
        ["after1", "after2"],
      );
    });

    it("round-trips seq: recovered entries carry the same seq push() returned", () => {
      const ch = createMessageChannel();
      const s1 = ch.push(msg("a"));
      const s2 = ch.push(msg("b"));
      const recovered = ch.recover();
      assert.deepEqual(
        recovered.map((e) => e.seq),
        [s1, s2],
      );
    });

    it("recovers a message consumed via the read-ahead fast-path (not lost)", async () => {
      const ch = createMessageChannel();
      const iter = ch.iterable[Symbol.asyncIterator]();

      // A waiting consumer (the SDK's streamInput read-ahead) is handed the
      // message immediately — it never sits in the queue.
      const pending = iter.next();
      ch.push(msg("consumed"));
      const consumed = await pending;
      assert.equal((consumed.value.message.content[0] as any).text, "consumed");

      // Its turn never completed (no ack), so recovery must return it.
      const recovered = ch.recover();
      assert.deepEqual(
        recovered.map((e) => text(e.msg)),
        ["consumed"],
      );
    });

    it("returns delivered-unacked messages before still-queued ones, in order", async () => {
      const ch = createMessageChannel();
      const iter = ch.iterable[Symbol.asyncIterator]();

      // m1 delivered to a waiting consumer (out of the queue)
      const p1 = iter.next();
      ch.push(msg("m1"));
      await p1;

      // m2, m3 pushed with no waiting consumer — they sit in the queue
      ch.push(msg("m2"));
      ch.push(msg("m3"));

      assert.deepEqual(
        ch.recover().map((e) => text(e.msg)),
        ["m1", "m2", "m3"],
      );
    });

    it("recover while iterator is waiting terminates the pending iterator", async () => {
      const ch = createMessageChannel();
      const iter = ch.iterable[Symbol.asyncIterator]();

      // Start waiting (sets resolve)
      const waiting = iter.next();

      // Recover should resolve the pending iterator with done:true
      const recovered = ch.recover();
      assert.deepEqual(recovered, []);

      const result = await waiting;
      assert.equal(result.done, true, "recover should terminate pending iterator");

      // Push to the same channel — goes to the queue (not the old resolve)
      ch.push(msg("new"));
      assert.deepEqual(
        ch.recover().map((e) => text(e.msg)),
        ["new"],
      );
    });

    it("does NOT return a message that was folded into a completed turn (#764)", async () => {
      // Regression test for the duplicate-event-on-rotation bug: the SDK folds
      // messages that arrive mid-run into the active run, so a folded message
      // never gets a `result`/ack of its own. The mind's turn-loop is
      // responsible for acking every message a turn covers (its driving message
      // plus anything folded in) — this test drives the channel the way
      // stream-consumer.ts does and checks recover() afterward.
      const ch = createMessageChannel();
      const iter = ch.iterable[Symbol.asyncIterator]();

      // Message A starts a turn (delivered to the SDK's read-ahead consumer).
      const pA = iter.next();
      const seqA = ch.push(msg("A"));
      await pA;

      // Message B arrives while A's turn is still live — the SDK folds it into
      // the running turn (delivered immediately via the read-ahead fast path,
      // same as A).
      const pB = iter.next();
      const seqB = ch.push(msg("B"));
      await pB;

      // A genuinely-unprocessed message C is queued after — no turn has
      // started for it yet.
      ch.push(msg("C"));

      // The turn resolves once: ack both A (its own driver) and B (folded in),
      // exactly as stream-consumer.ts's result handler does by seq.
      ch.ack(seqA);
      ch.ack(seqB);

      const recovered = ch.recover();
      assert.deepEqual(
        recovered.map((e) => text(e.msg)),
        ["C"],
        "B was folded into A's completed turn and must not be replayed; C is still owed a turn",
      );
    });
  });

  describe("isEmpty()", () => {
    it("is true for a fresh channel", () => {
      assert.equal(createMessageChannel().isEmpty(), true);
    });

    it("is false while a message is queued", () => {
      const ch = createMessageChannel();
      ch.push(msg("queued"));
      assert.equal(ch.isEmpty(), false);
    });

    it("is false while a delivered message is unacked (in flight)", async () => {
      const ch = createMessageChannel();
      const iter = ch.iterable[Symbol.asyncIterator]();
      const pending = iter.next();
      ch.push(msg("inflight"));
      await pending;
      assert.equal(ch.isEmpty(), false);
    });

    it("is true again after the in-flight message is acked", async () => {
      const ch = createMessageChannel();
      const iter = ch.iterable[Symbol.asyncIterator]();
      const pending = iter.next();
      const seq = ch.push(msg("done"));
      await pending;
      ch.ack(seq);
      assert.equal(ch.isEmpty(), true);
    });
  });

  describe("close()", () => {
    it("resolves a pending next() with done:true", async () => {
      const ch = createMessageChannel();
      const iter = ch.iterable[Symbol.asyncIterator]();
      const waiting = iter.next();
      ch.close();
      const result = await waiting;
      assert.equal(result.done, true);
    });

    it("makes subsequent next() calls return done", async () => {
      const ch = createMessageChannel();
      ch.close();
      const iter = ch.iterable[Symbol.asyncIterator]();
      const result = await iter.next();
      assert.equal(result.done, true);
    });

    it("leaves queued messages recoverable so nothing is dropped on reap", async () => {
      // Mirrors the reaper: a message that raced in before close() must still be
      // recoverable for re-dispatch into a fresh resumed session.
      const ch = createMessageChannel();
      ch.push(msg("raced"));
      ch.close();
      assert.deepEqual(
        ch.recover().map((e) => text(e.msg)),
        ["raced"],
      );
    });
  });

  describe("ack()", () => {
    it("excludes an acknowledged message from recovery", async () => {
      const ch = createMessageChannel();
      const iter = ch.iterable[Symbol.asyncIterator]();

      const pending = iter.next();
      const seq = ch.push(msg("done"));
      await pending;

      // The turn completed — acknowledge it.
      ch.ack(seq);
      assert.deepEqual(ch.recover(), []);
    });

    it("is identity-based: acking one delivered message doesn't touch the others", async () => {
      // Mirrors the compaction race: m1 is mid-turn when m2 and m3 are
      // read-ahead-delivered; m1's turn completes, then compaction recovers.
      const ch = createMessageChannel();
      const iter = ch.iterable[Symbol.asyncIterator]();

      const p1 = iter.next();
      const seq1 = ch.push(msg("m1"));
      await p1;
      const p2 = iter.next();
      ch.push(msg("m2"));
      await p2;
      const p3 = iter.next();
      ch.push(msg("m3"));
      await p3;

      ch.ack(seq1); // m1's turn finished

      assert.deepEqual(
        ch.recover().map((e) => text(e.msg)),
        ["m2", "m3"],
      );
    });

    it("does not remove a pre-turn-queued message when a later seq is acked", async () => {
      // The bug this identity-based ack replaces: a positional (shift-based) ack
      // would wrongly consume the oldest entry regardless of which turn actually
      // finished. Pushing m1, m2 then acking m2's seq specifically must leave m1
      // (still genuinely unprocessed) recoverable.
      const ch = createMessageChannel();
      ch.push(msg("m1"));
      const seq2 = ch.push(msg("m2"));

      ch.ack(seq2);

      assert.deepEqual(
        ch.recover().map((e) => text(e.msg)),
        ["m1"],
      );
    });

    it("is a no-op when the seq is not in flight or queued", () => {
      const ch = createMessageChannel();
      assert.doesNotThrow(() => ch.ack(999));
      assert.deepEqual(ch.recover(), []);
    });
  });
});
