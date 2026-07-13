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

/** Human-readable span between two DB timestamps, e.g. "12m", "3h", "just now". */
export function formatDuration(startStr: string, endStr: string): string {
  const start = new Date(normalizeTimestamp(startStr)).getTime();
  const end = new Date(normalizeTimestamp(endStr)).getTime();
  const mins = Math.round((end - start) / 60_000);
  if (mins < 1) return "moment";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  return `${hours}h`;
}
