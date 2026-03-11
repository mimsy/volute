import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractTextContent } from "../src/lib/delivery/delivery-router.js";
import { resolveSleepAction } from "../src/lib/delivery/message-delivery.js";

describe("extractTextContent", () => {
  it("returns string content as-is", () => {
    assert.equal(extractTextContent("hello world"), "hello world");
  });

  it("returns empty string as-is", () => {
    assert.equal(extractTextContent(""), "");
  });

  it("extracts text from content block array", () => {
    const blocks = [
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ];
    assert.equal(extractTextContent(blocks), "hello\nworld");
  });

  it("filters out non-text blocks", () => {
    const blocks = [
      { type: "text", text: "hello" },
      { type: "image", media_type: "image/png", data: "abc123" },
      { type: "text", text: "world" },
    ];
    assert.equal(extractTextContent(blocks), "hello\nworld");
  });

  it("filters out text blocks with missing text field", () => {
    const blocks = [{ type: "text", text: "hello" }, { type: "text" }, { type: "text", text: "" }];
    assert.equal(extractTextContent(blocks), "hello");
  });

  it("returns empty string for empty array", () => {
    assert.equal(extractTextContent([]), "");
  });

  it("JSON-stringifies non-string non-array input", () => {
    assert.equal(extractTextContent({ key: "value" }), '{"key":"value"}');
    assert.equal(extractTextContent(42), "42");
    assert.equal(extractTextContent(null), "null");
    assert.equal(extractTextContent(true), "true");
  });
});

describe("resolveSleepAction", () => {
  it("returns skip when whileSleeping is skip", () => {
    assert.equal(resolveSleepAction("skip", false, false), "skip");
  });

  it("returns skip even when wake trigger matches", () => {
    assert.equal(resolveSleepAction("skip", false, true), "skip");
  });

  it("trigger-wake queues and wakes when not already woken", () => {
    assert.equal(resolveSleepAction("trigger-wake", false, false), "queue-and-wake");
  });

  it("trigger-wake queues only when already woken by trigger", () => {
    assert.equal(resolveSleepAction("trigger-wake", true, false), "queue");
  });

  it("no behavior with wake trigger match queues and wakes", () => {
    assert.equal(resolveSleepAction(undefined, false, true), "queue-and-wake");
  });

  it("no behavior without wake trigger queues only", () => {
    assert.equal(resolveSleepAction(undefined, false, false), "queue");
  });

  it("explicit queue behavior just queues", () => {
    assert.equal(resolveSleepAction("queue", false, false), "queue");
  });

  it("explicit queue ignores wake trigger match", () => {
    assert.equal(resolveSleepAction("queue", false, true), "queue");
  });

  it("unknown behavior falls through to queue", () => {
    assert.equal(resolveSleepAction("invalid-value", false, true), "queue");
  });
});
