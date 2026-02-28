// SSE event types for the unified event stream

import type { ActivityEventType, ContentBlock, ConversationWithParticipants } from "./types.js";

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
export type SSEEvent = SSESnapshotEvent | SSEActivityEvent | SSEConversationEvent;

export type SSESnapshotEvent = {
  event: "snapshot";
  conversations: ConversationWithParticipants[];
  activity: Array<{
    id: number;
    type: ActivityEventType;
    mind: string;
    summary: string;
    metadata: Record<string, unknown> | null;
    created_at: string;
  }>;
  sites: Array<{
    name: string;
    label: string;
    pages: Array<{ file: string; modified: string; url: string }>;
  }>;
  recentPages: Array<{ mind: string; file: string; modified: string; url: string }>;
  activeMinds: string[];
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

/** Sequenced event wrapper for Last-Event-ID reconnection */
export type SequencedEvent = {
  id: string;
  data: SSEEvent;
};
