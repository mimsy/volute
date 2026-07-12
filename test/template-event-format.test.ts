import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatEventPrefix, formatPrefix } from "../templates/_base/src/lib/format-prefix.js";

describe("template event envelope formatting", () => {
  it("formats an event as [Event: <label> — <time>] with no sender line", () => {
    const prefix = formatEventPrefix("Schedule: morning-check", "2026-07-12 07:30:00");
    // Worded label, ambient framing, trailing newline before the body.
    assert.match(prefix, /^\[Event: Schedule: morning-check — 2026-07-12 \d{2}:\d{2}\]\n$/);
    // No sender/DM/platform framing leaks in.
    assert.ok(!prefix.includes("in DM"));
    assert.ok(!prefix.includes("Volute:"));
  });

  it("falls back to the current time when no timestamp is given", () => {
    const prefix = formatEventPrefix("Woke from sleep", undefined);
    assert.match(prefix, /^\[Event: Woke from sleep — \d{4}-\d{2}-\d{2} \d{2}:\d{2}\]\n$/);
  });

  it("a normal (non-event) message still gets the sender prefix, not an event prefix", () => {
    const prefix = formatPrefix(
      { channel: "@alice", sender: "alice", isDM: true },
      "2026-07-12 07:30",
    );
    assert.ok(prefix.includes("alice in DM"));
    assert.ok(!prefix.startsWith("[Event:"));
  });
});
