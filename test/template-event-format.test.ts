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

// #687: automated #system announcements are delivered on the ordinary channel path but with a
// null sender. The mind-facing prefix must frame them by channel and never name anyone — no
// spirit name, and no phantom "unknown" fallback in any of the formatting paths.
describe("sender-less channel announcements (#687)", () => {
  it("formatPrefix frames a sender-less channel post by channel, with no sender", () => {
    const prefix = formatPrefix({ channel: "#system", platform: "Volute" }, "2026-07-12 07:30");
    assert.match(prefix, /^\[Volute: #system — 2026-07-12 07:30\]/);
    assert.ok(!prefix.includes("unknown"), "must not invent an 'unknown' sender");
  });

  it("dispatch delivers a sender-less announcement with no sender attribution", () => {
    const handled: { content: VoluteContentPart[]; meta: HandlerMeta }[] = [];
    const router = createRouter({
      mindHandler: () => ({
        handle(content, meta) {
          handled.push({ content, meta });
          return () => {};
        },
      }),
    });

    router.dispatch([{ type: "text", text: "atlas has joined" }], "system", {
      channel: "#system",
      sender: null as unknown as undefined,
      isDM: false,
    });

    const text = (handled[0].content[0] as { type: "text"; text: string }).text;
    assert.ok(text.includes("atlas has joined"));
    assert.match(text, /^\[Volute: #system/, "framed by channel");
    assert.ok(!text.includes("unknown"), "no phantom sender");
    router.close();
  });

  it("dispatchBatch renders a sender-less announcement without an 'unknown' sender", () => {
    const handled: { content: VoluteContentPart[]; meta: HandlerMeta }[] = [];
    const router = createRouter({
      mindHandler: () => ({
        handle(content, meta) {
          handled.push({ content, meta });
          return () => {};
        },
      }),
    });

    router.dispatchBatch(
      { channels: { "#system": [{ sender: null, content: "atlas has joined" }] } },
      "system",
      {},
    );

    const text = (handled[0].content[0] as { type: "text"; text: string }).text;
    assert.ok(text.includes("atlas has joined"));
    assert.ok(!text.includes("unknown"), "batch flush must not invent an 'unknown' sender");
    router.close();
  });
});

// #493: the participant label a mind reads is the display term for a user's type. Humans render
// as `[human]` — the retired "brain" jargon must never surface here. The label is the raw
// user_type today (there is no "brain" value to migrate), so this test guards against a
// regression that reintroduces a human→"brain" mapping in the prefix formatter.
describe("participant profile labels (#493)", () => {
  it("labels a human participant [human] and never [brain]", () => {
    const prefix = formatPrefix(
      {
        channel: "#garden",
        sender: "alice",
        participantProfiles: [{ username: "alice", userType: "human", displayName: "Alice" }],
      },
      "2026-07-12 07:30",
    );
    assert.ok(prefix.includes("alice (Alice) [human]"), "human renders as [human]");
    assert.ok(!prefix.toLowerCase().includes("brain"), "the retired [brain] label must not return");
  });

  it("labels a mind participant [mind]", () => {
    const prefix = formatPrefix(
      {
        channel: "#garden",
        sender: "atlas",
        participantProfiles: [{ username: "atlas", userType: "mind" }],
      },
      "2026-07-12 07:30",
    );
    assert.ok(prefix.includes("atlas [mind]"), "mind renders as [mind]");
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
