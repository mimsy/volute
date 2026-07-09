// Pure liveness policy for the live turn timeline (TurnTimeline.svelte).
// Kept free of Svelte/DOM so it can be unit-tested directly.

import type { HistoryMessage } from "@volute/api";
import { normalizeTimestamp } from "./format";

// --- SSE reconnect backoff ---

/** Backoff delays (ms) applied on successive failed reconnect attempts, capped at the last value. */
export const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000];

/**
 * Delay before the next reconnect attempt.
 * @param attempt number of reconnects already tried (0 = first retry).
 */
export function reconnectDelay(attempt: number): number {
  const idx = Math.min(Math.max(attempt, 0), RECONNECT_BACKOFF_MS.length - 1);
  return RECONNECT_BACKOFF_MS[idx];
}

// --- Provisional (pending) inbound bounds ---

/** On load, an untagged inbound is only promoted to a provisional turn if newer than this. */
export const PENDING_INBOUND_MAX_AGE_MS = 2 * 60_000;
/** A provisional inbound with no turn_created after this long stops pretending to be active. */
export const PENDING_INBOUND_EXPIRY_MS = 3 * 60_000;

function timestampMs(dateStr: string): number {
  return new Date(normalizeTimestamp(dateStr)).getTime();
}

/** True if an inbound is recent enough to show as a provisional active turn. */
export function isRecentInbound(createdAt: string, now: number = Date.now()): boolean {
  const t = timestampMs(createdAt);
  if (Number.isNaN(t)) return false;
  return now - t <= PENDING_INBOUND_MAX_AGE_MS;
}

/** Drop provisional inbounds older than the expiry window. */
export function pruneExpiredInbounds(
  inbounds: HistoryMessage[],
  now: number = Date.now(),
): HistoryMessage[] {
  return inbounds.filter((ev) => {
    const t = timestampMs(ev.created_at);
    if (Number.isNaN(t)) return true; // keep un-parseable rather than silently dropping
    return now - t < PENDING_INBOUND_EXPIRY_MS;
  });
}

// --- Active-turn staleness guard ---

/** Matches the server's WEDGED_TURN_IDLE_MS (summarizer.ts): a still-"active" turn idle this
 *  long is likely finished on the server; refetch to converge instead of waiting for reload. */
export const STALE_TURN_IDLE_MS = 15 * 60_000;

/** True if an active turn's last streaming event is old enough to warrant a server refetch. */
export function isTurnStale(lastEventAtMs: number, now: number = Date.now()): boolean {
  return now - lastEventAtMs >= STALE_TURN_IDLE_MS;
}
