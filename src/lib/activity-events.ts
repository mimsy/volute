import { getDb } from "./db.js";
import log from "./logger.js";
import { activity } from "./schema.js";

export type ActivityEvent = {
  type:
    | "mind_started"
    | "mind_stopped"
    | "mind_active"
    | "mind_idle"
    | "mind_done"
    | "page_updated";
  mind: string;
  summary: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
};

type Callback = (event: ActivityEvent & { id: number; created_at: string }) => void;

const subscribers = new Set<Callback>();

export function subscribe(callback: Callback): () => void {
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
  };
}

export async function publish(event: ActivityEvent): Promise<void> {
  const created_at = event.created_at ?? new Date().toISOString().replace("T", " ").slice(0, 19);

  let id = 0;
  try {
    const db = await getDb();
    const result = await db.insert(activity).values({
      type: event.type,
      mind: event.mind,
      summary: event.summary,
      metadata: event.metadata ? JSON.stringify(event.metadata) : null,
      created_at,
    });
    id = Number(result.lastInsertRowid);
  } catch (err) {
    log.error("[activity-events] failed to persist activity", log.errorData(err));
  }

  const full = { ...event, id, created_at };
  notify(full);
}

/** Broadcast to subscribers without persisting to DB. */
export function broadcast(event: ActivityEvent): void {
  const created_at = event.created_at ?? new Date().toISOString().replace("T", " ").slice(0, 19);
  notify({ ...event, id: 0, created_at });
}

function notify(event: ActivityEvent & { id: number; created_at: string }): void {
  for (const cb of subscribers) {
    try {
      cb(event);
    } catch (err) {
      log.error("[activity-events] subscriber threw:", log.errorData(err));
      subscribers.delete(cb);
    }
  }
}
