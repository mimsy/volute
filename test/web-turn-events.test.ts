import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HistoryMessage } from "../packages/api/src/types.js";
import { isEventTriggeredTurn } from "../packages/web/src/ui/lib/turn-events.js";

/**
 * The timeline labels a turn's closing text "reflection · private" when the turn was triggered
 * by a system event — nothing was delivered to anyone, so it must not read like a reply.
 *
 * Getting the condition wrong is not cosmetic: it makes the history lie about what happened.
 * The rule must match the daemon's, which is TRIGGER-based (`linkPendingInbound` tags the turn
 * with the FIRST pending inbound-or-event row, and `captureReflection` only fires when that row
 * is an event). "Contains an event anywhere" is a different, wrong rule — events can land
 * mid-turn via `linkInboundToActiveTurn`.
 */
const row = (id: number, type: string, extra: Partial<HistoryMessage> = {}): HistoryMessage =>
  ({
    id,
    mind: "m",
    type,
    content: "",
    created_at: "2026-07-14 10:00:00",
    ...extra,
  }) as HistoryMessage;

describe("isEventTriggeredTurn", () => {
  it("an event-triggered turn is an event turn", () => {
    assert.ok(
      isEventTriggeredTurn([
        row(1, "event", { channel: "event:schedule:42" }),
        row(2, "tool_use"),
        row(3, "text", { content: "noted" }),
      ]),
    );
  });

  it("a message-triggered turn is not, even when an event lands mid-turn", () => {
    // The bug this guards: a human messages the mind, a scheduled event fires while the turn is
    // still running and gets attached to it, and the mind's reply — which really was delivered
    // to that human — gets stamped "reflection · private". The history would be lying.
    assert.ok(
      !isEventTriggeredTurn([
        row(1, "inbound", { channel: "@alice", sender: "alice" }),
        row(2, "event", { channel: "event:schedule:42" }),
        row(3, "text", { content: "on it, alice" }),
      ]),
    );
  });

  it("an event-triggered turn stays an event turn when a message lands mid-turn", () => {
    assert.ok(
      isEventTriggeredTurn([
        row(1, "event", { channel: "event:wake:7" }),
        row(2, "inbound", { channel: "@alice", sender: "alice" }),
      ]),
    );
  });

  it("a turn with no source row at all is not an event turn", () => {
    assert.ok(!isEventTriggeredTurn([row(1, "tool_use"), row(2, "text")]));
    assert.ok(!isEventTriggeredTurn([]));
  });
});
