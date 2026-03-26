import log from "../util/logger.js";

/**
 * In-process pub-sub for mind activity events. SSE endpoint subscribes per-mind;
 * daemon publishes when events arrive.
 *
 * MindEvent mirrors DaemonEvent (templates/_base/src/lib/daemon-client.ts) + { mind, createdAt }.
 * Keep these in sync when adding new event fields.
 */
export type MindEvent = {
  mind: string;
  type: string;
  session?: string;
  channel?: string;
  messageId?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  turnId?: string;
  sender?: string;
  createdAt?: string;
};

type Callback = (event: MindEvent) => void;

const subscribers = new Map<string, Set<Callback>>();
const globalSubscribers = new Set<Callback>();

export function subscribe(mind: string, callback: Callback): () => void {
  let set = subscribers.get(mind);
  if (!set) {
    set = new Set();
    subscribers.set(mind, set);
  }
  set.add(callback);
  return () => {
    set!.delete(callback);
    if (set!.size === 0) subscribers.delete(mind);
  };
}

export function subscribeAll(callback: Callback): () => void {
  globalSubscribers.add(callback);
  return () => {
    globalSubscribers.delete(callback);
  };
}

export function publish(mind: string, event: MindEvent): void {
  const set = subscribers.get(mind);
  if (set) {
    for (const cb of set) {
      try {
        cb(event);
      } catch (err) {
        log.error(`[mind-events] subscriber threw for ${mind}`, log.errorData(err));
        set.delete(cb);
        if (set.size === 0) subscribers.delete(mind);
      }
    }
  }
  for (const cb of globalSubscribers) {
    try {
      cb(event);
    } catch (err) {
      log.error("[mind-events] global subscriber threw", log.errorData(err));
      globalSubscribers.delete(cb);
    }
  }
}
