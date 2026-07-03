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

  describe("recover()", () => {
    it("returns all queued messages and empties the queue", async () => {
      const ch = createMessageChannel();
      ch.push(msg("x"));
      ch.push(msg("y"));
      ch.push(msg("z"));

      const recovered = ch.recover();
      assert.deepEqual(recovered.map(text), ["x", "y", "z"]);

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
      assert.deepEqual(recovered2.map(text), ["after1", "after2"]);
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
      assert.deepEqual(recovered.map(text), ["consumed"]);
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

      assert.deepEqual(ch.recover().map(text), ["m1", "m2", "m3"]);
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
      assert.deepEqual(ch.recover().map(text), ["new"]);
    });
  });

  describe("ack()", () => {
    it("excludes an acknowledged message from recovery", async () => {
      const ch = createMessageChannel();
      const iter = ch.iterable[Symbol.asyncIterator]();

      const pending = iter.next();
      ch.push(msg("done"));
      await pending;

      // The turn completed — acknowledge it.
      ch.ack();
      assert.deepEqual(ch.recover(), []);
    });

    it("acks the oldest delivered message (FIFO), recovering the rest", async () => {
      // Mirrors the compaction race: m1 is mid-turn when m2 and m3 are
      // read-ahead-delivered; m1's turn completes, then compaction recovers.
      const ch = createMessageChannel();
      const iter = ch.iterable[Symbol.asyncIterator]();

      const p1 = iter.next();
      ch.push(msg("m1"));
      await p1;
      const p2 = iter.next();
      ch.push(msg("m2"));
      await p2;
      const p3 = iter.next();
      ch.push(msg("m3"));
      await p3;

      ch.ack(); // m1's turn finished

      assert.deepEqual(ch.recover().map(text), ["m2", "m3"]);
    });

    it("is a no-op when nothing is in flight", () => {
      const ch = createMessageChannel();
      assert.doesNotThrow(() => ch.ack());
      assert.deepEqual(ch.recover(), []);
    });
  });
});
