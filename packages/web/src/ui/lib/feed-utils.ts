import type { ContentBlock, Message } from "@volute/api";
import { normalizeTimestamp } from "./format";

export function formatTime(dateStr: string): string {
  try {
    const d = new Date(normalizeTimestamp(dateStr));
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

export function showSenderHeader(messages: Message[], i: number): boolean {
  if (i === 0) return true;
  const prev = messages[i - 1];
  const cur = messages[i];
  return (prev.sender_name ?? prev.role) !== (cur.sender_name ?? cur.role);
}

export function extractTextContent(content: ContentBlock[]): string {
  return content
    .filter((b): b is ContentBlock & { type: "text" } => b.type === "text")
    .map((b) => b.text)
    .join("\n\n");
}
