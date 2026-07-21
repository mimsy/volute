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
  const marker = { type: "text" as const, text: RECOVERED_MESSAGE_NOTE };
  const content = msg.message.content;
  return {
    ...msg,
    message: {
      ...msg.message,
      content:
        typeof content === "string"
          ? [marker, { type: "text" as const, text: content }]
          : [marker, ...content],
    },
  };
}

/**
 * Re-push `recover()`'s output into a fresh channel and rebuild `messageIds` in
 * lockstep with it. Each entry's `id` carries over — matched by its *old* `seq` —
 * to the *new* seq the fresh channel mints on push, so the next turn's
 * currentMessageId/channel routing isn't corrupted by stale or missing ids (#764).
 *
 * Depends on `oldMessageIds` covering every id in `pending`: it relies on the current
 * turn (session.currentMessageId/currentSeq — not part of session.messageIds) being
 * complete and already acked by the time `recover()` runs, so its entry is absent from
 * both `pending` and `oldMessageIds` and never needs a match. That holds today because
 * the only abort site (agent.ts, in onTurnEnd) fires after the result handler has
 * cleared currentMessageId/currentSeq and acked the turn — abort never happens
 * mid-turn. If a future change (e.g. a hung-turn watchdog) aborts mid-turn, that
 * in-flight message would have no entry in oldMessageIds and would silently lose its
 * `id` here (see the `idBySeq.get` fallback to `undefined` below) — no test would catch
 * it, since the mismatch is silent misrouting, not a thrown error.
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
