// Synchronous stand-in for the product's fetchTurnEvents API call.
// The fixture registers per-turn event lists at module load; HistoryEvent
// looks them up when a turn is expanded.
import type { HistoryMessage } from "./types";

const turnEvents = new Map<string, HistoryMessage[]>();

export function registerTurnEvents(turnId: string, events: HistoryMessage[]) {
  turnEvents.set(turnId, events);
}

export function getTurnEvents(turnId: string | null): HistoryMessage[] {
  if (!turnId) return [];
  return turnEvents.get(turnId) ?? [];
}
