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

export function getEventsSince(sinceId: number): BufferedEvent[] {
  const now = Date.now();

  // Find the index of the first event after sinceId
  const startIdx = buffer.findIndex((e) => e.id > sinceId);
  if (startIdx === -1) return [];

  // Return events that aren't too old
  return buffer.slice(startIdx).filter((e) => now - e.timestamp < MAX_AGE_MS);
}

/** Reset state (for testing). */
export function resetSequencer(): void {
  nextId = 1;
  buffer.length = 0;
}
