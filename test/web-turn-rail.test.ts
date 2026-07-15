import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SummaryIcons, TurnRow } from "@volute/api";
import { summaryIconCount, turnRailParts } from "../packages/web/src/ui/lib/turn-rail.js";

function baseTurn(overrides: Partial<TurnRow>): TurnRow {
  return {
    id: "t1",
    mind: "m",
    summary: "did a thing",
    summary_meta: null,
    status: "complete",
    created_at: "2026-07-14 12:00:00",
    trigger: null,
    conversations: [],
    events: [],
    activities: [],
    ...overrides,
  };
}

const conv = (id: string, sourceIds: number[]) => ({
  id,
  label: `@${id}`,
  type: "dm" as const,
  messages: sourceIds.map((sid, i) => ({
    id: i,
    role: "user" as const,
    sender_name: "u",
    content: [{ type: "text", text: "hi" }],
    source_event_id: sid,
    created_at: "2026-07-14 12:00:00",
  })),
});

const evt = (id: number, label: string) => ({
  id,
  label,
  content: "tick",
  created_at: "2026-07-14 12:00:00",
});

describe("turnRailParts", () => {
  it("dedupes the triggering conversation from the stack", () => {
    const turn = baseTurn({
      trigger: { eventId: 42, channel: "@alice", sender: "alice", content: "hi" },
      conversations: [conv("alice", [42]), conv("bob", [7])],
    });
    const parts = turnRailParts(turn);
    assert.equal(parts.triggerConv?.id, "alice");
    assert.deepEqual(
      parts.stackConvs.map((c) => c.id),
      ["bob"],
    );
    assert.equal(parts.stackCount, 1);
  });

  it("dedupes the triggering system event from the stack", () => {
    const turn = baseTurn({
      trigger: {
        eventId: 9,
        channel: "event:schedule:9",
        sender: null,
        content: "tick",
        event: { type: "schedule", label: "Schedule" },
      },
      events: [evt(9, "Schedule"), evt(10, "Heartbeat")],
    });
    const parts = turnRailParts(turn);
    assert.equal(parts.triggerEvt?.id, 9);
    assert.deepEqual(
      parts.stackEvents.map((e) => e.id),
      [10],
    );
    assert.equal(parts.stackCount, 1);
  });

  it("stacks everything when there is no trigger", () => {
    const turn = baseTurn({
      conversations: [conv("alice", [1])],
      events: [evt(2, "Heartbeat")],
      activities: [
        {
          id: 3,
          type: "note_created",
          summary: "wrote",
          metadata: null,
          source_event_id: null,
          created_at: "2026-07-14 12:00:00",
        },
      ],
    });
    const parts = turnRailParts(turn);
    assert.equal(parts.triggerConv, undefined);
    assert.equal(parts.triggerEvt, undefined);
    assert.equal(parts.stackCount, 3);
  });

  it("dedupes nothing when the trigger doesn't resolve to turn data", () => {
    const turn = baseTurn({
      trigger: { eventId: 999, channel: "@alice", sender: "alice", content: "hi" },
      conversations: [conv("alice", [1])],
    });
    const parts = turnRailParts(turn);
    assert.equal(parts.triggerConv, undefined);
    assert.equal(parts.stackCount, 1);
  });
});

describe("summaryIconCount", () => {
  it("is 0 for missing icons", () => {
    assert.equal(summaryIconCount(undefined), 0);
    assert.equal(summaryIconCount(null), 0);
  });

  it("counts one chip per group", () => {
    const icons: SummaryIcons = {
      conversations: [
        { id: "a", label: "@a", type: "dm", count: 3 },
        { id: "b", label: "#b", type: "channel", count: 1 },
      ],
      events: [{ label: "Heartbeat", count: 5 }],
      activities: [
        { type: "note_created", count: 2, items: [] },
        { type: "page_published", count: 1, items: [] },
      ],
    };
    // conversations collapse to one chip, events to one, one per activity type
    assert.equal(summaryIconCount(icons), 4);
    assert.equal(summaryIconCount({ conversations: [], events: [], activities: [] }), 0);
  });
});
