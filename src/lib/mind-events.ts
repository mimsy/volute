/** In-process pub-sub for mind activity events. SSE endpoint subscribes per-mind; daemon publishes when events arrive. */
export type MindEvent = {
  mind: string;
  type: string;
  session?: string;
  channel?: string;
  messageId?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
};

type Callback = (event: MindEvent) => void;

const subscribers = new Map<string, Set<Callback>>();

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

export function publish(mind: string, event: MindEvent): void {
  const set = subscribers.get(mind);
  if (!set) return;
  for (const cb of set) {
    try {
      cb(event);
    } catch (err) {
      console.error("[mind-events] subscriber threw:", err);
      set.delete(cb);
      if (set.size === 0) subscribers.delete(mind);
    }
  }
}
