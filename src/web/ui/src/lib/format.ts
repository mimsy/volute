import type { Mind } from "./api";

export function mindDotColor(mind: Mind): string {
  const s = getDisplayStatus(mind);
  if (s === "running" || s === "active") return "var(--accent)";
  if (s === "starting") return "var(--yellow)";
  return "var(--text-2)";
}

/** Ensure a DB timestamp (UTC without Z) is parsed correctly. */
export function normalizeTimestamp(dateStr: string): string {
  return dateStr.endsWith("Z") ? dateStr : `${dateStr}Z`;
}

export function getDisplayStatus(mind: Mind): string {
  if (mind.status !== "running") return mind.status;
  if (!mind.lastActiveAt) return "running";
  const ago = Date.now() - new Date(normalizeTimestamp(mind.lastActiveAt)).getTime();
  return ago < 5 * 60_000 ? "active" : "running";
}

export function formatRelativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(normalizeTimestamp(dateStr)).getTime();
  const diff = now - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function getConversationLabel(
  participants: Array<{ username: string; userType: string }>,
  title: string | null,
  currentUsername: string,
  conv?: { type?: "dm" | "group" | "channel"; name?: string | null },
): string {
  if (conv?.type === "channel" && conv.name) return `#${conv.name}`;
  if (participants.length === 2) {
    const other = participants.find((p) => p.username !== currentUsername);
    if (other) return `@${other.username}`;
  }
  if (title) return title;
  const mindParticipants = participants.filter((p) => p.userType === "mind");
  if (mindParticipants.length > 0) return mindParticipants.map((a) => a.username).join(", ");
  return "Untitled";
}
