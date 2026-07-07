import type { HistoryMessage } from "./types";

/** Row types that can start a turn — i.e. the ones the daemon considers as a trigger. */
const SOURCE_TYPES = new Set(["inbound", "event"]);

/**
 * True when the turn was *triggered* by a system event.
 *
 * Mirrors the daemon: `linkPendingInbound` tags the turn with the first pending
 * inbound-or-event row as its `trigger_event_id`, and `captureReflection` only stores a
 * reflection when that trigger row is an event. So the trigger is the FIRST source row,
 * and later rows don't change what the turn was.
 *
 * Do not weaken this to "the turn contains an event anywhere". Events can land mid-turn
 * (`linkInboundToActiveTurn` attaches them to an already-running turn), so a turn triggered
 * by a human message can also hold an event row. Treating that as an event turn would label
 * the mind's reply — which really was delivered to that human — as a private reflection.
 */
export function isEventTriggeredTurn(events: HistoryMessage[]): boolean {
  const trigger = events.find((e) => SOURCE_TYPES.has(e.type));
  return trigger?.type === "event";
}
