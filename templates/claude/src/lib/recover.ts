import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ChannelEntry } from "./message-channel.js";
import type { MessageIdEntry } from "./stream-consumer.js";

/**
 * `recover()` returns messages the channel can't prove were unprocessed — a genuinely
 * unfinished turn looks identical to a stranded, already-completed one would have before
 * #764's ack fix. Mark every re-pushed message so the mind can check its own record
 * before redoing work: fail toward noise (a spurious note is cosmetic and self-correcting)
 * rather than silence (a missing one is invisible and produces a false permanent record).
 */
export const RECOVERED_MESSAGE_NOTE =
  "Note: this message is being redelivered after a session interruption. You may already " +
  "have handled it — check your recent work (e.g. journal, files) before repeating anything.";

export function markRecovered(msg: SDKUserMessage): SDKUserMessage {
  const content = msg.message.content;
  const blocks = typeof content === "string" ? [{ type: "text" as const, text: content }] : content;
  // A message can be recovered twice (consecutive rotations, up to
  // MAX_CONSECUTIVE_ROTATIONS) — don't stack the note on each pass.
  const first = blocks[0];
  if (first && "type" in first && first.type === "text" && first.text === RECOVERED_MESSAGE_NOTE) {
    return { ...msg, message: { ...msg.message, content: blocks } };
  }
  const marker = { type: "text" as const, text: RECOVERED_MESSAGE_NOTE };
  return { ...msg, message: { ...msg.message, content: [marker, ...blocks] } };
}

/**
 * Re-push `recover()`'s output into a fresh channel and append the result onto
 * `existingMessageIds` — mutated in place and returned, rather than replacing it.
 * That's not incidental: `existingMessageIds` may already hold an entry for a
 * message that raced in and was pushed into the SAME fresh channel/messageIds
 * while `recover()` was still pending (the idle reaper awaits the SDK subprocess's
 * shutdown before recovering — see agent.ts). Returning a fresh array for the
 * caller to assign over would silently discard that entry (#764) — appending
 * in place makes that mistake impossible at the call site.
 *
 * Each entry's `id` carries over — matched by its *old* `seq` — to the *new* seq
 * the fresh channel mints on push, so the next turn's currentMessageId/channel
 * routing isn't corrupted by stale or missing ids. A `pending` entry with no
 * match in `oldMessageIds` gets `id: undefined` (see the `idBySeq.get` fallback
 * below) rather than throwing — safe because `seq` is now globally unique
 * (message-channel.ts), so this can only happen if `oldMessageIds` itself was
 * incomplete, and losing routing info for one message beats losing the message.
 *
 * `existingMessageIds` has no default — deliberately. `= []` would let a call site
 * omit it and get back a fresh array to assign over, which is exactly the #764
 * clobber: silently discarding whatever the target array already held. Making it
 * required turns that omission into a compile error at every call site, including
 * ones written later.
 */
export function relockstepMessageIds(
  pending: ChannelEntry[],
  oldMessageIds: MessageIdEntry[],
  push: (msg: SDKUserMessage) => number,
  existingMessageIds: MessageIdEntry[],
  transform: (msg: SDKUserMessage) => SDKUserMessage = markRecovered,
): MessageIdEntry[] {
  const idBySeq = new Map(oldMessageIds.map((e) => [e.seq, e.id]));
  existingMessageIds.push(
    ...pending.map((entry) => ({
      id: idBySeq.get(entry.seq),
      seq: push(transform(entry.msg)),
    })),
  );
  return existingMessageIds;
}
