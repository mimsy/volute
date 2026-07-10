import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { messagesToText, textToMessages } from "../packages/web/src/ui/lib/clock-format.js";

describe("schedule message textarea helpers", () => {
  it("messagesToText joins a pool and falls back to message", () => {
    assert.equal(messagesToText({ messages: ["a", "b"] }), "a\nb");
    assert.equal(messagesToText({ message: "solo" }), "solo");
    // A pool wins over a stray message field
    assert.equal(messagesToText({ message: "solo", messages: ["a"] }), "a");
    assert.equal(messagesToText({}), "");
    assert.equal(messagesToText({ messages: [] }), "");
  });

  it("textToMessages maps one line to message, several to messages", () => {
    assert.deepEqual(textToMessages("solo"), { message: "solo" });
    assert.deepEqual(textToMessages("a\nb"), { messages: ["a", "b"] });
    // Blank lines and whitespace are dropped
    assert.deepEqual(textToMessages("  a  \n\n b \n  "), { messages: ["a", "b"] });
    assert.deepEqual(textToMessages("\n  one  \n"), { message: "one" });
    // Empty input means "no action fields" — PUT leaves the server value alone
    assert.deepEqual(textToMessages(""), {});
    assert.deepEqual(textToMessages("  \n \n"), {});
  });

  it("round-trips a pool through the textarea", () => {
    const pool = ["first prompt", "second prompt", "third prompt"];
    assert.deepEqual(textToMessages(messagesToText({ messages: pool })), { messages: pool });
    assert.deepEqual(textToMessages(messagesToText({ message: "only" })), { message: "only" });
  });
});
