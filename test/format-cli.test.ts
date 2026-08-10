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

  // Shape, not value: compactDateTime renders in local time, so asserting the literal
  // date would flip days on a runner in a distant timezone.
  const DATED = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] /;

  it("stamps compact lines with the date, not just the time (#869)", () => {
    // A date-less `[HH:MM]` made a multi-day transcript read as one afternoon.
    const line = formatMessageLine(
      {
        role: "user",
        sender_name: "cricket",
        content: [{ type: "text", text: "hi" }],
        created_at: at,
      },
      true,
    );
    assert.match(line, DATED);
    assert.match(line, /cricket: hi$/);
  });

  it("dates compact event lines too (#869)", () => {
    const line = formatMessageLine(
      {
        role: "event",
        sender_name: null,
        content: [{ type: "text", text: "atlas has joined" }],
        created_at: at,
      },
      true,
    );
    assert.match(line, DATED);
  });

  it("distinguishes messages from different days in compact mode (#869)", () => {
    const render = (created_at: string) =>
      formatMessageLine(
        {
          role: "user",
          sender_name: "cricket",
          content: [{ type: "text", text: "hi" }],
          created_at,
        },
        true,
      );
    // Same wall-clock time, three days apart: the lines must not be identical.
    assert.notEqual(render("2026-07-16 17:30:00"), render("2026-07-19 17:30:00"));
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
