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

  describe("drain()", () => {
    it("returns all queued messages and empties the queue", async () => {
      const ch = createMessageChannel();
      ch.push(msg("x"));
      ch.push(msg("y"));
      ch.push(msg("z"));

      const drained = ch.drain();
      assert.equal(drained.length, 3);
      assert.equal((drained[0].message.content[0] as any).text, "x");
      assert.equal((drained[1].message.content[0] as any).text, "y");
      assert.equal((drained[2].message.content[0] as any).text, "z");

      // Queue should now be empty — next push goes to a fresh queue
      ch.push(msg("after"));
      const iter = ch.iterable[Symbol.asyncIterator]();
      const r = await iter.next();
      assert.equal((r.value.message.content[0] as any).text, "after");
    });

    it("returns empty array when queue is empty", () => {
      const ch = createMessageChannel();
      const drained = ch.drain();
      assert.deepEqual(drained, []);
    });

    it("messages pushed after drain are not affected", async () => {
      const ch = createMessageChannel();
      ch.push(msg("before"));
      ch.drain();

      ch.push(msg("after1"));
      ch.push(msg("after2"));
      const drained2 = ch.drain();
      assert.equal(drained2.length, 2);
      assert.equal((drained2[0].message.content[0] as any).text, "after1");
      assert.equal((drained2[1].message.content[0] as any).text, "after2");
    });

    it("clears pending resolve so iterator does not steal drained messages", async () => {
      const ch = createMessageChannel();
      const iter = ch.iterable[Symbol.asyncIterator]();

      // Start a consumer waiting for a message (sets resolve)
      const pending = iter.next();

      // Push a message — this goes to the pending resolve, not the queue
      ch.push(msg("consumed"));
      const consumed = await pending;
      assert.equal((consumed.value.message.content[0] as any).text, "consumed");

      // Now push more and drain
      ch.push(msg("queued1"));
      ch.push(msg("queued2"));
      const drained = ch.drain();
      assert.equal(drained.length, 2);
    });

    it("drain while iterator is waiting nulls out the resolve", async () => {
      const ch = createMessageChannel();
      const iter = ch.iterable[Symbol.asyncIterator]();

      // Start waiting (sets resolve)
      const waiting = iter.next();

      // Drain should clear the pending resolve
      const drained = ch.drain();
      assert.deepEqual(drained, []);

      // Push to new channel — the old waiting promise never resolves,
      // but new pushes go to the queue (not the old resolve)
      ch.push(msg("new"));
      const newDrained = ch.drain();
      assert.equal(newDrained.length, 1);
      assert.equal((newDrained[0].message.content[0] as any).text, "new");

      // The old waiting promise is orphaned — this is expected behavior
      // (in production the old channel is replaced after drain)
      void waiting; // suppress unhandled rejection
    });
  });
});
