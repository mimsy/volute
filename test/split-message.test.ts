import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { splitMessage } from "../src/connectors/sdk.js";

describe("splitMessage", () => {
  it("returns single chunk for short messages", () => {
    assert.deepEqual(splitMessage("hello", 2000), ["hello"]);
  });

  it("returns empty array for empty string", () => {
    assert.deepEqual(splitMessage("", 2000), []);
  });

  it("splits at newline boundary when possible", () => {
    const line1 = "a".repeat(1500);
    const line2 = "b".repeat(1000);
    const message = `${line1}\n${line2}`;
    const chunks = splitMessage(message, 2000);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0], line1);
    assert.equal(chunks[1], line2);
  });

  it("hard splits when no good newline found", () => {
    const message = "a".repeat(3000);
    const chunks = splitMessage(message, 2000);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].length, 2000);
    assert.equal(chunks[1].length, 1000);
  });

  it("prefers newline in second half of max length", () => {
    // Newline at position 1500 (in second half of 2000) should be used
    const before = "a".repeat(1500);
    const after = "b".repeat(1000);
    const message = `${before}\n${after}`;
    const chunks = splitMessage(message, 2000);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0], before);
    assert.equal(chunks[1], after);
  });

  it("ignores newline in first half (too early)", () => {
    // Newline at position 500 (in first half of 2000) — too early, hard split instead
    const before = "a".repeat(500);
    const after = "b".repeat(2500);
    const message = `${before}\n${after}`;
    const chunks = splitMessage(message, 2000);
    assert.equal(chunks[0].length, 2000);
  });

  it("handles multiple chunks", () => {
    const message = "a".repeat(5000);
    const chunks = splitMessage(message, 2000);
    assert.equal(chunks.length, 3);
    assert.equal(chunks[0].length, 2000);
    assert.equal(chunks[1].length, 2000);
    assert.equal(chunks[2].length, 1000);
  });
});
