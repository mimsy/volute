import type { SummaryIcons, TurnConversation, TurnRow, TurnSystemEvent } from "@volute/api";

// Rail decoration model shared by the top-level timeline and nested branch
// rows: a turn's trigger renders at the marker/dot position, and everything
// else that happened in it stacks along the rail below.

export type TurnRailParts = {
  /** The conversation containing the triggering message, if resolvable. */
  triggerConv?: TurnConversation;
  /** The triggering system event, if resolvable. */
  triggerEvt?: TurnSystemEvent;
  /** Conversations minus the trigger's — the stack must not repeat the marker. */
  stackConvs: TurnConversation[];
  /** System events minus the trigger. */
  stackEvents: TurnSystemEvent[];
  /** Total stack chips (conversations + events + activities). */
  stackCount: number;
};

export function turnRailParts(turn: TurnRow): TurnRailParts {
  const trigger = turn.trigger;
  const triggerConv =
    trigger && !trigger.event
      ? turn.conversations.find((cv) =>
          cv.messages.some((m) => m.source_event_id === trigger.eventId),
        )
      : undefined;
  const triggerEvt = trigger?.event
    ? turn.events.find((ev) => ev.id === trigger.eventId)
    : undefined;
  const stackConvs = turn.conversations.filter((cv) => cv !== triggerConv);
  const stackEvents = turn.events.filter((ev) => ev !== triggerEvt);
  return {
    triggerConv,
    triggerEvt,
    stackConvs,
    stackEvents,
    stackCount: stackConvs.length + stackEvents.length + turn.activities.length,
  };
}

/** Number of grouped chips a summary's icon set renders (one per group). */
export function summaryIconCount(icons: SummaryIcons | undefined | null): number {
  if (!icons) return 0;
  return (
    (icons.conversations.length > 0 ? 1 : 0) +
    (icons.events.length > 0 ? 1 : 0) +
    icons.activities.length
  );
}
