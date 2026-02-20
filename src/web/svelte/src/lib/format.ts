export function formatRelativeTime(dateStr: string): string {
  const now = Date.now();
  const normalized = dateStr.endsWith("Z") ? dateStr : `${dateStr}Z`;
  const then = new Date(normalized).getTime();
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
): string {
  if (participants.length === 2) {
    const other = participants.find((p) => p.username !== currentUsername);
    if (other) return `@${other.username}`;
  }
  if (title) return title;
  const mindParticipants = participants.filter((p) => p.userType === "mind");
  if (mindParticipants.length > 0) return mindParticipants.map((a) => a.username).join(", ");
  return "Untitled";
}
