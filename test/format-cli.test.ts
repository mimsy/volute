import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatMessageLine, formatSender } from "../packages/cli/src/lib/format-cli.js";

describe("formatSender", () => {
  it("renders 'Display Name (@username)' when a distinct display name exists", () => {
    assert.equal(formatSender("cricket", "Cricket Song"), "Cricket Song (@cricket)");
  });

  it("returns the name unchanged when there is no display name", () => {
    assert.equal(formatSender("cricket", null), "cricket");
    assert.equal(formatSender("cricket", undefined), "cricket");
    assert.equal(formatSender("cricket"), "cricket");
  });

  it("returns the name unchanged when the display name equals the username", () => {
    assert.equal(formatSender("cricket", "cricket"), "cricket");
  });
});

describe("formatMessageLine", () => {
  const at = "2026-07-16 17:30:00";

  it("renders a normal message with its sender", () => {
    const line = formatMessageLine(
      {
        role: "user",
        sender_name: "cricket",
        content: [{ type: "text", text: "hi" }],
        created_at: at,
      },
      true,
    );
    assert.match(line, /cricket: hi$/);
  });

  it("renders a display name in human (non-compact) mode", () => {
    const line = formatMessageLine(
      {
        role: "user",
        sender_name: "cricket",
        sender_display_name: "Cricket Song",
        content: [{ type: "text", text: "hi" }],
        created_at: at,
      },
      false,
    );
    assert.match(line, /Cricket Song \(@cricket\): hi$/);
  });

  it("renders an announcement (role event) sender-less with a · marker in compact mode (#687)", () => {
    const line = formatMessageLine(
      {
        role: "event",
        sender_name: null,
        content: [{ type: "text", text: "atlas has joined" }],
        created_at: at,
      },
      true,
    );
    // The `] · text` shape (no `sender:` between the bracket and the middot) is the proof
    // it's sender-less; the timestamp itself legitimately contains a colon.
    assert.match(line, /\] · atlas has joined$/);
  });

  it("renders an announcement sender-less in human mode too (#687)", () => {
    const line = formatMessageLine(
      {
        role: "event",
        sender_name: null,
        content: [{ type: "text", text: "atlas has joined" }],
        created_at: at,
      },
      false,
    );
    assert.match(line, /· atlas has joined$/);
  });

  it("keeps an event sender-less even if a sender_name is present — role wins (#687)", () => {
    const line = formatMessageLine(
      {
        role: "event",
        sender_name: "iris",
        content: [{ type: "text", text: "atlas has joined" }],
        created_at: at,
      },
      true,
    );
    assert.match(line, /· atlas has joined$/);
    assert.ok(!line.includes("iris"), "an event must never be attributed to a sender");
  });
});
