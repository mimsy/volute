export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  toolCalls?: { name: string; input: unknown }[];
  done?: boolean;
  timestamp: number;
};
