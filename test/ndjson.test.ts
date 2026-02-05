import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readNdjson } from "../src/lib/ndjson.js";

function toStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const results = [];
  for await (const event of readNdjson(stream)) {
    results.push(event);
  }
  return results;
}

describe("readNdjson", () => {
  it("parses well-formed NDJSON stream", async () => {
    const stream = toStream(['{"type":"text","content":"hello"}\n{"type":"done"}\n']);
    const events = await collect(stream);
    assert.equal(events.length, 2);
    assert.deepEqual(events[0], { type: "text", content: "hello" });
    assert.deepEqual(events[1], { type: "done" });
  });

  it("handles data split across chunks", async () => {
    const stream = toStream(['{"type":"tex', 't","content":"split"}\n']);
    const events = await collect(stream);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], { type: "text", content: "split" });
  });

  it("skips invalid JSON lines", async () => {
    const stream = toStream(['{"type":"text","content":"ok"}\nnot-json\n{"type":"done"}\n']);
    const events = await collect(stream);
    assert.equal(events.length, 2);
    assert.deepEqual(events[0], { type: "text", content: "ok" });
    assert.deepEqual(events[1], { type: "done" });
  });

  it("handles trailing data in buffer", async () => {
    const stream = toStream(['{"type":"done"}']);
    const events = await collect(stream);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], { type: "done" });
  });

  it("handles empty stream", async () => {
    const stream = toStream([]);
    const events = await collect(stream);
    assert.equal(events.length, 0);
  });

  it("handles empty lines between records", async () => {
    const stream = toStream(['{"type":"text","content":"a"}\n\n\n{"type":"done"}\n']);
    const events = await collect(stream);
    assert.equal(events.length, 2);
    assert.deepEqual(events[0], { type: "text", content: "a" });
    assert.deepEqual(events[1], { type: "done" });
  });
});
