import { firstReplyableEntry, isEventTurn } from "./event-turn.js";
import type { MindPrompts } from "./startup.js";
import type { ChannelMeta } from "./types.js";

/** Context a template prepends to a turn: either the event note or reply instructions. */
export type TurnContext = {
  content: string;
  source: "event-instructions" | "reply-instructions";
};

/** The mutable per-session state this decision reads and updates. */
export type TurnContextState = {
  eventNoteFired: boolean;
  /**
   * Reply instructions have been given in this model context (what `once` counts). Cleared
   * by `newModelContext` wherever a template rebuilds the context.
   */
  replyInstructionsFired: boolean;
};

/**
 * The model's context was just rebuilt — a rotation, or a fresh start in place — so the
 * reply instructions it was given are gone from what it can see. `once` means once per
 * model context, not per session object: each template's session object spans a different
 * window (claude's survives a rotation), and a mind that has lost the reminder, a small
 * model above all, may stop answering where anyone can hear (#1226). A session created
 * anew starts clear and needs no call.
 */
export function newModelContext(state: TurnContextState): void {
  state.replyInstructionsFired = false;
}

/** What the decision needs to know about each message the turn runs. */
export type TurnEntry = Pick<
  ChannelMeta,
  "channel" | "replyChannel" | "sender" | "isEvent" | "replyInstructions"
>;

/**
 * Decide what context (if any) to prepend to a turn over `entries` — the messages it runs,
 * oldest first. Returns null for "nothing". Every template makes this call, so a mind is
 * told the same things whichever one it runs on.
 *
 * A system event is not a message: reply instructions must never fire on an event turn.
 * Naming the event's synthetic channel tells the mind to `volute chat send event:...`, i.e.
 * to reply to its own environment. The send is rejected, and the mind is left puzzling over
 * a message nobody sent (observed: the seed "lucy" spent her first turn on exactly this).
 *
 * The event note fires once per session, not once per event: it states a standing fact about
 * events (also in VOLUTE.md), and each event arrives on a distinct channel, so keying it on
 * the channel would fire it on every single event.
 *
 * Reply instructions follow the thread's routes.json `replyInstructions`, which the daemon
 * resolves and sends with each delivery: `once` (the default) gives them on the first message
 * of each model context (see newModelContext) — not once per channel — `always` on every turn
 * with someone to answer, and `never` not at all.
 */
export function turnContextFor(
  turnEntries: TurnEntry[],
  session: TurnContextState,
  prompts: MindPrompts,
): TurnContext | null {
  // A batch names who to answer in `replyChannel` rather than `channel` (see types.ts).
  const entries = turnEntries.map((e) => ({ ...e, channel: e.channel ?? e.replyChannel }));
  // A turn that also carries a real message is a message turn: there is someone to answer.
  if (isEventTurn(entries)) {
    if (session.eventNoteFired) return null;
    session.eventNoteFired = true;
    return { content: prompts.event_instructions, source: "event-instructions" };
  }

  // Name a channel the mind can actually send to — never an event's.
  const entry = firstReplyableEntry(entries);
  if (!entry) return null;
  const mode = entry.replyInstructions ?? "once";
  if (mode === "never") return null;
  if (mode === "once" && session.replyInstructionsFired) return null;
  session.replyInstructionsFired = true;
  return {
    content: prompts.reply_instructions.replace(/\$\{channel\}/g, entry.channel),
    source: "reply-instructions",
  };
}
