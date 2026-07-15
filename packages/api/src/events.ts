// SSE event types for the unified event stream

import type {
  ActivityEventType,
  ActivityItem,
  ContentBlock,
  ConversationWithParticipants,
} from "./types.js";

/** Conversation-scoped events (messages, typing) */
export type ConversationEvent =
  | {
      type: "message";
      id: number;
      role: "user" | "assistant";
      senderName: string | null;
      content: ContentBlock[];
      createdAt: string;
    }
  | { type: "typing"; senders: string[] };

/** Activity events for mind lifecycle */
export type ActivityEvent = {
  type: ActivityEventType;
  mind: string;
  summary: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
};

/** Unified SSE event envelope sent over /api/v1/events */
export type SSEEvent =
  | SSESnapshotEvent
  | SSEActivityEvent
  | SSEConversationEvent
  | SSEConversationAddedEvent;

export type SSESnapshotEvent = {
  event: "snapshot";
  conversations: ConversationWithParticipants[];
  activity: ActivityItem[];
  activeMinds: string[];
  onlineBrains: string[];
};

export type SSEActivityEvent = {
  event: "activity";
  id: number;
  type: ActivityEventType;
  mind: string;
  summary: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

export type SSEConversationEvent = {
  event: "conversation";
  conversationId: string;
} & ConversationEvent;

/**
 * Sent when the caller becomes a participant of a conversation that did not
 * exist (or wasn't theirs) at connect time — e.g. a seed's first DM. Lets the
 * client add the conversation to its list live, without a reconnect/snapshot.
 */
export type SSEConversationAddedEvent = {
  event: "conversation_added";
  conversation: ConversationWithParticipants;
};

/** Sequenced event wrapper for Last-Event-ID reconnection */
export type SequencedEvent = {
  id: string;
  data: SSEEvent;
};
