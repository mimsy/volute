import type { ContentBlock } from "@volute/api";

export type ChatEntry = {
  id: number;
  serverId?: number;
  role: "user" | "assistant";
  blocks: ContentBlock[];
  senderName?: string;
  createdAt?: string;
};
