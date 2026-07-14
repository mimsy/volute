import { isEventChannel } from "./event-turn.js";
import type { MindPrompts } from "./startup.js";
import type { ChannelMeta } from "./types.js";

/** Context the template prepends to a turn: either the event note or reply instructions. */
export type TurnContext = {
  content: string;
  source: "event-instructions" | "reply-instructions";
};

/** The mutable per-session state this decision reads and updates. */
export type TurnContextState = {
  eventNoteFired: boolean;
  firstMessagePerChannel: Set<string>;
};

/**
 * Decide what context (if any) to prepend to an incoming turn. Returns null for "nothing".
 *
 * Pulled out of agent.ts so it can actually be tested: this is the rule that keeps a system
 * event from looking like a message. Reply instructions must never fire on an event turn —
 * naming the event's synthetic channel tells the mind to `volute chat send event:...`, i.e.
 * to reply to its own environment. The send is rejected, and the mind is left puzzling over
 * a message nobody sent (observed: the seed "lucy" spent her first turn on exactly this).
 *
 * The event note fires once per session, not once per event: it states a standing fact about
 * events (also in VOLUTE.md), and it is deliberately NOT keyed on `firstMessagePerChannel`,
 * whose key is a distinct channel per event id and so would fire on every single event.
 */
export function turnContextFor(
  meta: ChannelMeta,
  session: TurnContextState,
  prompts: MindPrompts,
): TurnContext | null {
  const channel = meta.channel;

  if (meta.isEvent || isEventChannel(channel)) {
    if (session.eventNoteFired) return null;
    session.eventNoteFired = true;
    return { content: prompts.event_instructions, source: "event-instructions" };
  }

  if (!channel || session.firstMessagePerChannel.has(channel)) return null;
  session.firstMessagePerChannel.add(channel);

  const content =
    meta.sender === "volute"
      ? "This is a system message — no reply is needed."
      : prompts.reply_instructions.replace(/\$\{channel\}/g, channel);
  return { content, source: "reply-instructions" };
}
