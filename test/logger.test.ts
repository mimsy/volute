import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLogBuffer, logBuffer } from "../packages/daemon/src/lib/util/log-buffer.js";

describe("logger", () => {
  it("logBuffer.append stores entries retrievable via getEntries", () => {
    const before = logBuffer.getEntries().length;
    logBuffer.append({ level: "info", msg: "test entry", ts: new Date().toISOString() });
    const after = logBuffer.getEntries();
    assert.ok(after.length > before);
    const last = after[after.length - 1];
    assert.equal(last.msg, "test entry");
    assert.equal(last.level, "info");
  });

  it("logBuffer.subscribe notifies on new entries", () => {
    const received: Array<{ level: string; msg: string }> = [];
    const unsub = logBuffer.subscribe((entry) => received.push(entry));
    logBuffer.append({ level: "warn", msg: "sub test", ts: new Date().toISOString() });
    unsub();
    logBuffer.append({ level: "error", msg: "after unsub", ts: new Date().toISOString() });
    assert.equal(received.length, 1);
    assert.equal(received[0].msg, "sub test");
    assert.equal(received[0].level, "warn");
  });

  it("circular buffer wraps around correctly", () => {
    const buf = createLogBuffer(3);
    const entry = (n: number) => ({ level: "info", msg: `msg-${n}`, ts: "t" });
    buf.append(entry(1));
    buf.append(entry(2));
    buf.append(entry(3));
    assert.equal(buf.getEntries().length, 3);
    assert.deepEqual(
      buf.getEntries().map((e) => e.msg),
      ["msg-1", "msg-2", "msg-3"],
    );
    buf.append(entry(4));
    assert.equal(buf.getEntries().length, 3);
    assert.deepEqual(
      buf.getEntries().map((e) => e.msg),
      ["msg-2", "msg-3", "msg-4"],
    );
    buf.append(entry(5));
    buf.append(entry(6));
    assert.deepEqual(
      buf.getEntries().map((e) => e.msg),
      ["msg-4", "msg-5", "msg-6"],
    );
  });

  it("log writes structured JSON to stderr", async () => {
    // Dynamically import to test the actual log module
    const log = (await import("../packages/daemon/src/lib/util/logger.js")).default;
    const chunks: Buffer[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = (chunk: Uint8Array | string) => {
      chunks.push(Buffer.from(chunk));
      return true;
    };
    try {
      log.info("structured test", { key: "val" });
    } finally {
      process.stderr.write = origWrite;
    }
    const output = Buffer.concat(chunks).toString();
    const parsed = JSON.parse(output.trim());
    assert.equal(parsed.level, "info");
    assert.equal(parsed.msg, "structured test");
    assert.equal(parsed.data.key, "val");
    assert.ok(parsed.ts);
  });
});
