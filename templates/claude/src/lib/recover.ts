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
 * Re-push `recover()`'s output into a fresh channel and rebuild `messageIds` in
 * lockstep with it. Each entry's `id` carries over — matched by its *old* `seq` —
 * to the *new* seq the fresh channel mints on push, so the next turn's
 * currentMessageId/channel routing isn't corrupted by stale or missing ids (#764).
 * A `pending` entry with no match in `oldMessageIds` gets `id: undefined` (see the
 * `idBySeq.get` fallback below) rather than throwing — safe because `seq` is now
 * globally unique (message-channel.ts), so this can only happen if `oldMessageIds`
 * itself was incomplete, and losing routing info for one message beats losing the
 * message.
 */
export function relockstepMessageIds(
  pending: ChannelEntry[],
  oldMessageIds: MessageIdEntry[],
  push: (msg: SDKUserMessage) => number,
  transform: (msg: SDKUserMessage) => SDKUserMessage = markRecovered,
): MessageIdEntry[] {
  const idBySeq = new Map(oldMessageIds.map((e) => [e.seq, e.id]));
  return pending.map((entry) => ({
    id: idBySeq.get(entry.seq),
    seq: push(transform(entry.msg)),
  }));
}
