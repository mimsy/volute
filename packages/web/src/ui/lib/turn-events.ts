import type { HistoryMessage } from "@volute/api";

/** Row types that can start a turn — i.e. the ones the daemon considers as a trigger. */
const SOURCE_TYPES = new Set(["inbound", "event"]);

/**
 * True when the turn was *triggered* by a system event.
 *
 * Mirrors the daemon: `linkRowsToTurn` (or `linkPendingInbound`) tags the turn with the
 * first inbound-or-event row as its `trigger_event_id`, and `captureReflection` only stores a
 * reflection when that trigger row is an event. So the trigger is the FIRST source row,
 * and later rows don't change what the turn was.
 *
 * Do not weaken this to "the turn contains an event anywhere". Events can land mid-turn
 * (`DeliveryManager.enterTurn` attaches them to an already-running turn), so a turn triggered
 * by a human message can also hold an event row. Treating that as an event turn would label
 * the mind's reply — which really was delivered to that human — as a private reflection.
 */
export function isEventTriggeredTurn(events: HistoryMessage[]): boolean {
  const trigger = events.find((e) => SOURCE_TYPES.has(e.type));
  return trigger?.type === "event";
}

/**
 * Whether `events` already shows the row `event` names. An outbound is published at send
 * time and again when a turn claims it, under its row id both times (#1179), and a turn's
 * fetched rows can already hold it; a second entry for it would show the send twice.
 * Synthetic ids (≤ 0) name no row.
 */
export function showsRow(events: HistoryMessage[], event: HistoryMessage): boolean {
  return event.id > 0 && events.some((e) => e.id === event.id);
}

/**
 * A turn's fetched rows, plus the live rows that arrived while the fetch was in flight: a
 * row the read missed (an outbound claimed just after it) would otherwise vanish from the
 * live view when the fetch replaces it. Only rows with real ids can be matched, so only
 * those are carried over.
 */
export function withLiveRows(
  fetched: HistoryMessage[],
  live: HistoryMessage[] | undefined,
): HistoryMessage[] {
  const missed = (live ?? []).filter((e) => e.id > 0 && !showsRow(fetched, e));
  return missed.length > 0 ? [...fetched, ...missed] : fetched;
}
