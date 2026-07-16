import type { ContentBlock } from "@volute/api";

export type ChatEntry = {
  id: number;
  serverId?: number;
  // "event" is a sender-less automated announcement (e.g. #system "X has joined"),
  // rendered as an event line rather than a chat bubble (#687).
  role: "user" | "assistant" | "event";
  blocks: ContentBlock[];
  senderName?: string;
  createdAt?: string;
};
