/**
 * Stale-send hold gate for multi-mind conversations.
 *
 * Problem: several minds in one channel independently compose replies to the same
 * message. Without coordination they post near-identical parallel responses. The old
 * fix — aborting a mind's turn mid-tool via the SDK interrupt — produced the Claude
 * Code "the user doesn't want to proceed / rejected" tool result, which minds read as
 * a reprimand (a mind must never have a tool use rejected).
 *
 * This gate replaces that. When a mind starts a turn we snapshot the latest message
 * id it has seen in that conversation (the "baseline"). When the mind then tries to
 * send a reply, if another participant has posted since the baseline, we DON'T post —
 * we return a plain notice (surfaced as ordinary `volute chat send` stdout, fully
 * under our control, no SDK framing) so the mind can revise or re-send. We hold at
 * most once per turn so a busy channel can't trap a mind in a resend loop.
 *
 * State is in-memory and turn-scoped, mirroring other ephemeral daemon state
 * (SessionState, activeTurns). Ordering uses the monotonic `messages.id`
 * auto-increment column; `created_at` is only 1-second granularity.
 */
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { getDb } from "../db.js";
import { messages } from "../schema.js";

type TurnState = { baselineId: number; heldThisTurn: boolean; turnOpen: boolean };

// mindBase -> conversationId -> TurnState
const state = new Map<string, Map<string, TurnState>>();

export interface UnseenMessage {
  sender: string;
  text: string;
}

export interface StaleSendResult {
  held: boolean;
  unseen?: UnseenMessage[];
}

/** Extract joined text from a stored message `content` column (JSON ContentBlock[]). */
function extractText(raw: string | null): string {
  if (!raw) return "";
  try {
    const blocks = JSON.parse(raw);
    if (Array.isArray(blocks)) {
      return blocks
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join(" ")
        .trim();
    }
  } catch {
    // content wasn't JSON — fall through to the raw string
  }
  return String(raw);
}

async function maxMessageId(conversationId: string): Promise<number> {
  const db = await getDb();
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.conversation_id, conversationId))
    .orderBy(desc(messages.id))
    .limit(1);
  return rows[0]?.id ?? 0;
}

/**
 * Record that a message from `conversationId` was delivered to a mind. The first
 * delivery of a turn (turn not currently open) snapshots the baseline — the latest
 * message id the mind has now seen. Mid-turn deliveries leave the baseline untouched;
 * those are exactly the "arrived while composing" messages a stale send should catch.
 *
 * Awaited before the mind receives the message so the baseline is set before it can
 * possibly reply.
 */
export async function onDeliveredToMind(mindBase: string, conversationId?: string): Promise<void> {
  if (!conversationId) return;
  let conv = state.get(mindBase);
  if (!conv) {
    conv = new Map();
    state.set(mindBase, conv);
  }
  const existing = conv.get(conversationId);
  if (existing?.turnOpen) return; // mid-turn — keep the turn-start baseline
  const baselineId = await maxMessageId(conversationId);
  conv.set(conversationId, { baselineId, heldThisTurn: false, turnOpen: true });
}

/**
 * Decide whether a mind's pending send is stale. Held when there's an open turn, we
 * haven't already held this turn, and another participant (not in `excludeSenders`)
 * posted to the conversation after the baseline. On hold we mark the turn held-once
 * and advance the baseline so those messages count as seen for the resend.
 */
export async function checkStaleSend(
  mindBase: string,
  conversationId: string,
  excludeSenders: string[],
): Promise<StaleSendResult> {
  const entry = state.get(mindBase)?.get(conversationId);
  if (!entry?.turnOpen || entry.heldThisTurn) return { held: false };

  const db = await getDb();
  const rows = await db
    .select({ id: messages.id, sender: messages.sender_name, content: messages.content })
    .from(messages)
    .where(and(eq(messages.conversation_id, conversationId), gt(messages.id, entry.baselineId)))
    .orderBy(asc(messages.id));

  const excluded = new Set(excludeSenders.filter(Boolean));
  const unseen = rows.filter((r) => r.sender && !excluded.has(r.sender));
  if (unseen.length === 0) return { held: false };

  entry.heldThisTurn = true;
  entry.baselineId = rows[rows.length - 1].id; // mark everything up to now as seen
  return {
    held: true,
    unseen: unseen.map((r) => ({ sender: r.sender as string, text: extractText(r.content) })),
  };
}

/**
 * Drop all gate state for a mind. `onDeliveredToMind` re-snapshots a fresh baseline
 * on the next delivery, so deleting the mind's inner map is behavior-equivalent to
 * clearing the flags — and, unlike flipping flags, keeps `state` from growing one
 * permanent entry per conversation the mind is ever delivered into.
 */
export function clearMind(mindBase: string): void {
  state.delete(mindBase);
}

/**
 * Close all open turns for a mind (called on its `done` event) so the next delivery
 * re-snapshots a fresh baseline.
 */
export function resetTurn(mindBase: string): void {
  clearMind(mindBase);
}

/** Build the notice the held mind reads as its send command output. */
export function formatHoldNotice(channelLabel: string, unseen: UnseenMessage[]): string {
  const lines = unseen.map((m) => {
    const t = m.text.length > 120 ? `${m.text.slice(0, 119)}…` : m.text;
    return `  ${m.sender}: ${JSON.stringify(t)}`;
  });
  const n = unseen.length;
  return [
    `⚠ Not sent — ${n} newer message${n === 1 ? "" : "s"} arrived on ${channelLabel} while you were composing:`,
    ...lines,
    "Your message was NOT posted. Revise it in light of these, or run the same send again to post as-is.",
  ].join("\n");
}

/** Test seam: clear all gate state. */
export function _resetAllForTest(): void {
  state.clear();
}

/** Test seam: number of minds currently holding gate state. */
export function _stateSizeForTest(): number {
  return state.size;
}
