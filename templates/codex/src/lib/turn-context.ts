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
  /** Reply instructions have been given in this session — they're given once. */
  replyInstructionsFired: boolean;
};

/**
 * Decide what context (if any) to prepend to a turn over `metas` — the messages it runs,
 * oldest first. Returns null for "nothing".
 *
 * Pulled out of agent.ts so it can actually be tested: this is the rule that keeps a system
 * event from looking like a message. Reply instructions must never fire on an event turn —
 * naming the event's synthetic channel tells the mind to `volute chat send event:...`, i.e.
 * to reply to its own environment. The send is rejected, and the mind is left puzzling over
 * a message nobody sent (observed: the seed "lucy" spent her first turn on exactly this).
 *
 * The event note fires once per session, not once per event: it states a standing fact about
 * events (also in VOLUTE.md), and each event arrives on a distinct channel, so keying it on
 * the channel would fire it on every single event.
 *
 * Reply instructions are given once per session, as the claude template's hook gives them
 * (hooks/reply-instructions.ts) — not once per channel, as codex used to. A system message's
 * "no reply is needed" doesn't spend that one firing, so the first real message still gets
 * told how to answer. (routes.json's `replyInstructions` never reaches any template — #1205.)
 */
export function turnContextFor(
  metas: ChannelMeta[],
  session: TurnContextState,
  prompts: MindPrompts,
): TurnContext | null {
  const isEvent = (m: ChannelMeta) => m.isEvent || isEventChannel(m.channel);

  // A turn that also carries a real message is a message turn: there is someone to answer.
  if (metas.length > 0 && metas.every(isEvent)) {
    if (session.eventNoteFired) return null;
    session.eventNoteFired = true;
    return { content: prompts.event_instructions, source: "event-instructions" };
  }

  if (session.replyInstructionsFired) return null;
  // Name a channel the mind can actually send to — never an event's.
  const meta = metas.find((m) => m.channel && !isEvent(m));
  const channel = meta?.channel;
  if (!meta || !channel) return null;
  if (meta.sender === "volute") {
    return {
      content: "This is a system message — no reply is needed.",
      source: "reply-instructions",
    };
  }
  session.replyInstructionsFired = true;
  return {
    content: prompts.reply_instructions.replace(/\$\{channel\}/g, channel),
    source: "reply-instructions",
  };
}
