import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HistoryMessage } from "../packages/api/src/types.js";
import {
  isEventTriggeredTurn,
  showsRow,
  withLiveRows,
} from "../packages/web/src/ui/lib/turn-events.js";

/**
 * The timeline labels a turn's closing text "reflection · private" when the turn was triggered
 * by a system event — nothing was delivered to anyone, so it must not read like a reply.
 *
 * Getting the condition wrong is not cosmetic: it makes the history lie about what happened.
 * The rule must match the daemon's, which is TRIGGER-based (`linkRowsToTurn` or
 * `linkPendingInbound` tags the turn with the FIRST inbound-or-event row, and
 * `captureReflection` only fires when that row is an event). "Contains an event anywhere" is
 * a different, wrong rule — events can land mid-turn via `DeliveryManager.enterTurn`.
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

describe("live outbound rows (#1179)", () => {
  it("a re-published outbound the turn already shows is not shown again", () => {
    const shown = [row(10, "inbound"), row(11, "outbound", { turn_id: "t1" })];
    assert.equal(showsRow(shown, row(11, "outbound", { turn_id: "t1" })), true);
    assert.equal(showsRow(shown, row(12, "outbound")), false);
    assert.equal(showsRow([row(-1, "text")], row(-1, "text")), false, "synthetic ids name no row");
  });

  it("a fetch keeps the live rows its read missed, and only those", () => {
    const fetched = [row(10, "inbound"), row(11, "text")];
    const live = [row(-3, "inbound"), row(11, "text"), row(12, "outbound", { turn_id: "t1" })];
    assert.deepEqual(
      withLiveRows(fetched, live).map((e) => e.id),
      [10, 11, 12],
    );
    assert.equal(withLiveRows(fetched, undefined), fetched);
  });
});
