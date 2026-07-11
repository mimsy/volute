import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatCron,
  messagesToText,
  textToMessages,
} from "../packages/web/src/ui/lib/clock-format.js";

describe("formatCron", () => {
  it("renders interval and time-of-day crons", () => {
    assert.equal(formatCron("*/5 * * * *"), "every 5 minutes");
    assert.equal(formatCron("0 */2 * * *"), "every 2 hours");
    assert.equal(formatCron("0 9 * * *"), "daily at 9am");
    assert.equal(formatCron("30 14 * * 1"), "Mondays at 2:30pm");
  });

  it("appends the timezone label only to time-of-day phrases", () => {
    // Wall-clock crons are daemon-local — the label disambiguates them.
    assert.equal(formatCron("0 9 * * *", "EST"), "daily at 9am EST");
    assert.equal(formatCron("30 14 * * 1", "EST"), "Mondays at 2:30pm EST");
    // Interval crons have no time-of-day, so no label is added.
    assert.equal(formatCron("*/5 * * * *", "EST"), "every 5 minutes");
    assert.equal(formatCron("0 */2 * * *", "EST"), "every 2 hours");
  });
});

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
