import type { SSEConversationEvent } from "@volute/api/events";
import type { ContentBlock } from "./conversations.js";
import { bufferEvent } from "./event-sequencer.js";

/** In-process pub-sub for conversation events. SSE endpoint subscribes per-conversation; conversations.ts publishes when messages are added. */
export type ConversationEvent =
  | {
      type: "message";
      id: number;
      role: "user" | "assistant" | "event";
      senderName: string | null;
      content: ContentBlock[];
      createdAt: string;
    }
  | { type: "typing"; senders: string[] };

// `seq` is the global sequencer id under which this event was buffered exactly once
// (for reconnect replay); subscribers forward using it rather than re-buffering.
type Callback = (event: ConversationEvent & { seq: number }) => void;

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

// Global (not per-conversation) pub-sub for "a user became a participant of a
// conversation". Lets already-connected SSE streams start following a
// conversation that was created after they connected (e.g. a seed's first DM).
// Not buffered in the sequencer — a reconnect rebuilds subscriptions from a
// fresh snapshot, so replay is unnecessary.
type ParticipantAddedEvent = { conversationId: string; userId: number };
type ParticipantCallback = (event: ParticipantAddedEvent) => void;

const participantSubscribers = new Set<ParticipantCallback>();

export function subscribeParticipantAdded(callback: ParticipantCallback): () => void {
  participantSubscribers.add(callback);
  return () => participantSubscribers.delete(callback);
}

export function publishParticipantAdded(conversationId: string, userId: number): void {
  for (const cb of participantSubscribers) {
    try {
      cb({ conversationId, userId });
    } catch (err) {
      // Drop a throwing subscriber (likely a dead stream), mirroring publish().
      console.error("[conversation-events] participant subscriber threw:", err);
      participantSubscribers.delete(cb);
    }
  }
}

export function publish(conversationId: string, event: ConversationEvent): void {
  const set = subscribers.get(conversationId);
  if (!set) return;
  // Buffer once globally here, at the single publish site, so N clients subscribed
  // to this conversation don't each store a duplicate copy in the replay ring.
  const data: SSEConversationEvent = { event: "conversation", conversationId, ...event };
  const seq = bufferEvent(data);
  const delivered = { ...event, seq };
  for (const cb of set) {
    try {
      cb(delivered);
    } catch (err) {
      console.error("[conversation-events] subscriber threw:", err);
      set.delete(cb);
      if (set.size === 0) subscribers.delete(conversationId);
    }
  }
}
