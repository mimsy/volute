import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatEventPrefix, formatPrefix } from "../templates/_base/src/lib/format-prefix.js";
import { createRouter } from "../templates/_base/src/lib/router.js";
import type { HandlerMeta, VoluteContentPart } from "../templates/_base/src/lib/types.js";

describe("template event envelope formatting", () => {
  it("formats an event as a fenced system-event heading with no sender line", () => {
    const prefix = formatEventPrefix("Schedule: morning-check", "2026-07-12 07:30:00");
    // Worded label, ambient framing, trailing newline before the body.
    assert.match(
      prefix,
      /^=== System event: Schedule: morning-check — 2026-07-12 \d{2}:\d{2} ===\n$/,
    );
    // No sender/DM/platform framing leaks in.
    assert.ok(!prefix.includes("in DM"));
    assert.ok(!prefix.includes("Volute:"));
  });

  it("does not use the bracketed shape a message prefix uses", () => {
    // The whole point: an event must not be pattern-matchable to a message. A mind that
    // reads `[... — time]` as a message prefix tries to reply to it (the pi/codex bug).
    const eventPrefix = formatEventPrefix("Orientation", "2026-07-12 07:30:00");
    const messagePrefix = formatPrefix(
      { channel: "@alice", sender: "alice", isDM: true },
      "2026-07-12 07:30",
    );
    assert.ok(messagePrefix.startsWith("["));
    assert.ok(!eventPrefix.startsWith("["));
    assert.ok(!eventPrefix.includes("[Event:"));
  });

  it("falls back to the current time when no timestamp is given", () => {
    const prefix = formatEventPrefix("Woke from sleep", undefined);
    assert.match(
      prefix,
      /^=== System event: Woke from sleep — \d{4}-\d{2}-\d{2} \d{2}:\d{2} ===\n$/,
    );
  });

  it("a normal (non-event) message still gets the sender prefix, not an event prefix", () => {
    const prefix = formatPrefix(
      { channel: "@alice", sender: "alice", isDM: true },
      "2026-07-12 07:30",
    );
    assert.ok(prefix.includes("alice in DM"));
    assert.ok(!prefix.startsWith("==="));
  });
});

describe("router event dispatch", () => {
  it("applies the system-event heading and no sender/DM framing to an event dispatch", () => {
    const handled: { content: VoluteContentPart[]; meta: HandlerMeta }[] = [];
    const router = createRouter({
      mindHandler: () => ({
        handle(content, meta) {
          handled.push({ content, meta });
          return () => {};
        },
      }),
    });

    router.dispatch([{ type: "text", text: "Review the journal." }], "main", {
      isEvent: true,
      eventLabel: "Schedule: morning-check",
      eventAt: "2026-07-13 07:30:00",
      channel: "event:schedule:42",
    });

    assert.equal(handled.length, 1);
    const text = (handled[0].content[0] as { type: "text"; text: string }).text;
    assert.match(
      text,
      /^=== System event: Schedule: morning-check — \d{4}-\d{2}-\d{2} \d{2}:\d{2} ===\n/,
    );
    assert.ok(text.includes("Review the journal."));
    // No sender/DM/platform framing anywhere in the formatted turn.
    assert.ok(!text.includes("in DM"));
    assert.ok(!text.includes("Volute:"));
    // The event channel rides through to the handler for turn attribution.
    assert.equal(handled[0].meta.channel, "event:schedule:42");
    assert.equal(handled[0].meta.isEvent, true);
    router.close();
  });
});
