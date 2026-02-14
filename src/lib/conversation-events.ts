import type { ContentBlock } from "./conversations.js";

/** In-process pub-sub for conversation events. SSE endpoint subscribes per-conversation; conversations.ts publishes when messages are added. */
export type ConversationEvent = {
  type: "message";
  id: number;
  role: "user" | "assistant";
  senderName: string | null;
  content: ContentBlock[];
  createdAt: string;
};

type Callback = (event: ConversationEvent) => void;

const subscribers = new Map<string, Set<Callback>>();

export function subscribe(conversationId: string, callback: Callback): () => void {
  let set = subscribers.get(conversationId);
  if (!set) {
    set = new Set();
    subscribers.set(conversationId, set);
  }
  set.add(callback);
  return () => {
    set!.delete(callback);
    if (set!.size === 0) subscribers.delete(conversationId);
  };
}

export function publish(conversationId: string, event: ConversationEvent): void {
  const set = subscribers.get(conversationId);
  if (!set) return;
  for (const cb of set) {
    try {
      cb(event);
    } catch (err) {
      console.error("[conversation-events] subscriber threw:", err);
      set.delete(cb);
      if (set.size === 0) subscribers.delete(conversationId);
    }
  }
}
