/**
 * System events are not messages. They arrive on a synthetic `event:<type>:<id>` channel,
 * which exists purely so the daemon can attribute the turn (and capture the mind's closing
 * reflection) — it is NOT a channel anyone can send to.
 *
 * Every template must therefore agree on two things, which is why the rule lives here
 * rather than being re-derived in each one:
 *
 *  - reply instructions must never name an event channel. Telling a mind to
 *    `volute chat send event:orientation:1 "..."` sends it to reply to its own environment;
 *    the send is rejected and the mind is left confused about what it did wrong.
 *  - an event turn gets the event note instead — once per session, since it states a
 *    standing fact (also documented in VOLUTE.md) rather than anything about this event.
 */

/** Channel prefix identifying a system event's synthetic attribution channel. */
export const EVENT_CHANNEL_PREFIX = "event:";

/** Whether a channel is a system event's synthetic channel rather than a real destination. */
export function isEventChannel(channel: string | undefined | null): boolean {
  return !!channel?.startsWith(EVENT_CHANNEL_PREFIX);
}

/**
 * The first entry a reply could actually be sent to. Event channels are skipped: they are
 * turn-attribution handles, not reply targets.
 */
export function firstReplyableEntry<T extends { channel: string }>(entries: T[]): T | undefined {
  return entries.find((e) => !isEventChannel(e.channel));
}

/**
 * Whether this turn was triggered purely by system events (so it gets the event note and no
 * reply instructions). A turn that also carries a real message is a message turn — the mind
 * does have someone to answer.
 */
export function isEventTurn(entries: { channel: string }[]): boolean {
  return entries.length > 0 && entries.every((e) => isEventChannel(e.channel));
}
