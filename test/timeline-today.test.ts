import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SummaryRow, TurnRow } from "@volute/api";
import { buildTodayItems } from "../packages/web/src/ui/lib/timeline-today.js";

// A fixed "now": 2026-07-09 13:30 local time.
const NOW = new Date(2026, 6, 9, 13, 30, 0);

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Build a local UTC-ish "YYYY-MM-DD HH:MM:SS" string for a local wall-clock time today. */
function localTimeStr(hour: number, minute: number): string {
  const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), hour, minute, 0);
  // Turn timestamps are stored UTC without a Z; buildTodayItems appends Z, so emit UTC.
  return d.toISOString().replace("T", " ").slice(0, 19);
}

function hourSummary(hour: number): SummaryRow {
  const key = `${NOW.getFullYear()}-${pad2(NOW.getMonth() + 1)}-${pad2(NOW.getDate())}T${pad2(hour)}`;
  return {
    id: 1000 + hour,
    mind: "m",
    period: "hour",
    period_key: key,
    content: `hour ${hour}`,
    metadata: null,
    created_at: localTimeStr(hour, 0),
  };
}

function turn(id: string, completedHour: number, completedMin: number, active = false): TurnRow {
  const ts = localTimeStr(completedHour, completedMin);
  return {
    id,
    mind: "m",
    summary: active ? null : "did a thing",
    summary_meta: active ? null : { to_time: ts },
    status: active ? "active" : "complete",
    created_at: ts,
    trigger: null,
    conversations: [],
    activities: [],
  };
}

describe("buildTodayItems", () => {
  const noneActive = () => false;

  it("hides turns whose hour already has a summary", () => {
    const items = buildTodayItems({
      now: NOW,
      hourSummaries: [hourSummary(10)],
      turnsData: [turn("a", 10, 15)],
      isActive: noneActive,
    });
    // Only the hour summary; the covered turn is folded into it.
    assert.deepEqual(
      items.map((i) =>
        i.kind === "summary" ? `s:${i.summary.period_key.slice(-2)}` : `t:${i.turn.id}`,
      ),
      ["s:10"],
    );
  });

  it("renders uncovered-hour turns individually, in chronological position", () => {
    // Hours 10 and 12 have summaries; turns at 11:xx do not → they must slot between.
    const items = buildTodayItems({
      now: NOW,
      hourSummaries: [hourSummary(12), hourSummary(10)],
      turnsData: [turn("t11a", 11, 5), turn("t11b", 11, 40)],
      isActive: noneActive,
    });
    assert.deepEqual(
      items.map((i) =>
        i.kind === "summary" ? `s:${i.summary.period_key.slice(-2)}` : `t:${i.turn.id}`,
      ),
      ["s:10", "t:t11a", "t:t11b", "s:12"],
    );
  });

  it("always shows current-hour turns even with no summary", () => {
    const items = buildTodayItems({
      now: NOW,
      hourSummaries: [],
      turnsData: [turn("cur", 13, 10)],
      isActive: noneActive,
    });
    assert.deepEqual(
      items.map((i) => (i.kind === "turn" ? i.turn.id : "s")),
      ["cur"],
    );
  });

  it("buckets a turn by completion time, not start (cross-hour turn)", () => {
    // Started 10:55 (hour 10 is summarized) but completed 11:05 (hour 11 has no
    // summary). It must bucket to the completion hour and render individually,
    // not vanish into hour 10's summary.
    const startTs = localTimeStr(10, 55);
    const endTs = localTimeStr(11, 5);
    const crossHourTurn: TurnRow = {
      id: "cross",
      mind: "m",
      summary: "did a thing",
      summary_meta: { to_time: endTs },
      status: "complete",
      created_at: startTs,
      trigger: null,
      conversations: [],
      activities: [],
    };
    const items = buildTodayItems({
      now: NOW,
      hourSummaries: [hourSummary(10)],
      turnsData: [crossHourTurn],
      isActive: noneActive,
    });
    assert.deepEqual(
      items.map((i) =>
        i.kind === "summary" ? `s:${i.summary.period_key.slice(-2)}` : `t:${i.turn.id}`,
      ),
      ["s:10", "t:cross"],
    );
  });

  it("always shows active turns and sorts them last", () => {
    const items = buildTodayItems({
      now: NOW,
      hourSummaries: [hourSummary(10)],
      turnsData: [turn("live", 13, 20, true), turn("t11", 11, 0)],
      isActive: (t) => t.status === "active",
    });
    const ids = items.map((i) =>
      i.kind === "summary" ? "s:10" : i.kind === "separator" ? "sep" : `t:${i.turn.id}`,
    );
    // The uncovered 11:00 turn is "earlier today"; the split lands before the
    // current-hour (active) turn.
    assert.deepEqual(ids, ["s:10", "t:t11", "sep", "t:live"]);
  });

  it("splits earlier today from this hour's turns", () => {
    const items = buildTodayItems({
      now: NOW,
      hourSummaries: [hourSummary(10), hourSummary(12)],
      turnsData: [turn("cur", 13, 10)],
      isActive: noneActive,
    });
    const ids = items.map((i) =>
      i.kind === "summary"
        ? `s:${i.summary.period_key.slice(-2)}`
        : i.kind === "separator"
          ? `sep:${i.above}/${i.below}`
          : `t:${i.turn.id}`,
    );
    assert.deepEqual(ids, ["s:10", "s:12", "sep:earlier today/this hour", "t:cur"]);
  });

  it("no split when the current hour has nothing above it", () => {
    const items = buildTodayItems({
      now: NOW,
      hourSummaries: [],
      turnsData: [turn("cur", 13, 10)],
      isActive: noneActive,
    });
    assert.deepEqual(
      items.map((i) => i.kind),
      ["turn"],
    );
  });
});
