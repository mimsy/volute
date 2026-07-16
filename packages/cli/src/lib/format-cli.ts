/** Whether output should be compact (mind context). */
export const isCompact = () => !!process.env.VOLUTE_MIND;

/**
 * Render a sender for human-facing output. When a distinct display name exists,
 * shows "Display Name (@username)"; otherwise returns the name unchanged.
 */
export function formatSender(name: string, displayName?: string | null): string {
  if (displayName && displayName !== name) return `${displayName} (@${name})`;
  return name;
}

/** Format a DB timestamp as HH:MM */
export function compactTime(dateStr: string): string {
  const d = new Date(dateStr.endsWith("Z") ? dateStr : `${dateStr}Z`);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Format a DB timestamp as YYYY-MM-DD HH:MM */
export function compactDateTime(dateStr: string): string {
  const d = new Date(dateStr.endsWith("Z") ? dateStr : `${dateStr}Z`);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day} ${h}:${min}`;
}

export type ReadLineMessage = {
  role: string;
  sender_name: string | null;
  sender_display_name?: string | null;
  content: string | { type: string; text?: string }[];
  created_at: string;
};

/**
 * Render one `chat read` line. Automated announcements (`role: "event"`, #687) render
 * sender-less as `[time] · text` — role wins even if a sender_name is somehow present, so an
 * event is never attributed to anyone. Everything else renders `[time] sender: text`, with
 * display names in human (non-compact) mode.
 */
export function formatMessageLine(msg: ReadLineMessage, compact: boolean): string {
  const text = Array.isArray(msg.content)
    ? msg.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("")
    : msg.content;
  const time = compact
    ? compactTime(msg.created_at)
    : new Date(
        msg.created_at.endsWith("Z") ? msg.created_at : `${msg.created_at}Z`,
      ).toLocaleString();
  if (msg.role === "event") return `[${time}] · ${text}`;
  // Compact (mind-facing) output stays terse; display names are for humans.
  const sender = compact
    ? (msg.sender_name ?? msg.role)
    : formatSender(msg.sender_name ?? msg.role, msg.sender_display_name);
  return `[${time}] ${sender}: ${text}`;
}
