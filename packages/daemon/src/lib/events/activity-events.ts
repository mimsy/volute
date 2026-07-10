import type { SSEActivityEvent } from "@volute/api/events";
import { getDb } from "../db.js";
import { activity } from "../schema.js";
import log from "../util/logger.js";
import { bufferEvent } from "./event-sequencer.js";

export type ActivityEvent = {
  type:
    | "mind_started"
    | "mind_stopped"
    | "mind_active"
    | "mind_idle"
    | "mind_done"
    | "mind_error"
    | "mind_sleeping"
    | "mind_waking"
    | "page_updated"
    | "page_published"
    | "page_removed"
    | "note_created"
    | "brain_online"
    | "brain_offline"
    | "profile_updated"
    | "backup_failed";
  mind: string;
  summary: string;
  metadata?: Record<string, unknown>;
  turn_id?: string;
  source_event_id?: number;
  created_at?: string;
};

// `seq` is the global sequencer id under which this event was buffered exactly once
// (for reconnect replay); subscribers forward using it rather than re-buffering.
type Callback = (event: ActivityEvent & { id: number; created_at: string; seq: number }) => void;

const subscribers = new Set<Callback>();

export function subscribe(callback: Callback): () => void {
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
  };
}

export async function publish(event: ActivityEvent): Promise<number> {
  const created_at = event.created_at ?? new Date().toISOString().replace("T", " ").slice(0, 19);

  let id = 0;
  try {
    const db = await getDb();
    const result = await db.insert(activity).values({
      type: event.type,
      mind: event.mind,
      summary: event.summary,
      metadata: event.metadata ? JSON.stringify(event.metadata) : null,
      turn_id: event.turn_id ?? null,
      source_event_id: event.source_event_id ?? null,
      created_at,
    });
    id = Number(result.lastInsertRowid);
  } catch (err) {
    log.error("[activity-events] failed to persist activity", log.errorData(err));
  }

  const full = { ...event, id, created_at };
  notify(full);
  return id;
}

/** Broadcast to subscribers without persisting to DB. */
export function broadcast(event: ActivityEvent): void {
  const created_at = event.created_at ?? new Date().toISOString().replace("T", " ").slice(0, 19);
  notify({ ...event, id: 0, created_at });
}

function notify(event: ActivityEvent & { id: number; created_at: string }): void {
  // Buffer once globally here, at the single publish site, so N connected clients
  // don't each store a duplicate copy in the replay ring (which shrank the effective
  // replay window by N×). Subscribers forward using the shared `seq`.
  const data: SSEActivityEvent = {
    event: "activity",
    ...event,
    metadata: event.metadata ?? null,
  };
  const seq = bufferEvent(data);
  const delivered = { ...event, seq };
  for (const cb of subscribers) {
    try {
      cb(delivered);
    } catch (err) {
      log.error("[activity-events] subscriber threw:", log.errorData(err));
      subscribers.delete(cb);
    }
  }
}
