export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  toolCalls?: { name: string; input: unknown }[];
  timestamp: number;
};
