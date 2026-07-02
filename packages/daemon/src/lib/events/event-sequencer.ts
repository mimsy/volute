import type { SSEEvent } from "@volute/api/events";

/** Monotonically increasing event IDs with in-memory ring buffer for reconnection replay. */

const BUFFER_SIZE = 1000;
const MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

type BufferedEvent = {
  id: number;
  data: SSEEvent;
  timestamp: number;
};

let nextId = 1;
const buffer: BufferedEvent[] = [];

export function bufferEvent(data: SSEEvent): number {
  const id = nextId++;
  buffer.push({ id, data, timestamp: Date.now() });

  // Trim: remove oldest entries beyond buffer size
  while (buffer.length > BUFFER_SIZE) {
    buffer.shift();
  }

  return id;
}

/** Allocate an event ID without buffering (for connection-specific events). */
export function nextEventId(): number {
  return nextId++;
}

/**
 * Replay buffered events after `sinceId` that the caller is entitled to see.
 * The buffer is global, so audience must be enforced here per event type:
 * - Snapshot events are connection-specific and never replayed to anyone.
 * - Conversation events are only replayed to participants of that conversation.
 * - Activity events (which include another mind's AI-generated turn summaries)
 *   are gated to the caller's own mind. `allowedActivityMind === undefined`
 *   means a privileged caller (admin/system) who may see the global feed.
 * The audience is decided explicitly per event type; unknown event types are
 * denied so a newly-added type can never leak by default.
 */
export function getEventsSince(
  sinceId: number,
  allowedConversationIds: Set<string>,
  allowedActivityMind: string | undefined,
): BufferedEvent[] {
  const now = Date.now();

  // Find the index of the first event after sinceId
  const startIdx = buffer.findIndex((e) => e.id > sinceId);
  if (startIdx === -1) return [];

  return buffer.slice(startIdx).filter((e) => {
    if (now - e.timestamp >= MAX_AGE_MS) return false;
    const data = e.data;
    switch (data.event) {
      case "snapshot":
        return false;
      case "conversation":
        return allowedConversationIds.has(data.conversationId);
      case "activity":
        return allowedActivityMind === undefined || data.mind === allowedActivityMind;
      default:
        return false;
    }
  });
}

/** Reset state (for testing). */
export function resetSequencer(): void {
  nextId = 1;
  buffer.length = 0;
}
