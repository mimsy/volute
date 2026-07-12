import type { ChannelMeta, ParticipantProfile } from "./types.js";

/** Compact timestamp: YYYY-MM-DD HH:MM */
export function compactTimestamp(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${h}:${min}`;
}

/** Compact time-only: HH:MM */
export function compactTime(date: Date = new Date()): string {
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${min}`;
}

/**
 * Prefix for a system-event turn: `[Event: <label> — <local time>]`. No sender, no
 * platform/DM framing — events come from the environment, not a person.
 */
export function formatEventPrefix(label: string, at: string | undefined): string {
  let time = "";
  if (at) {
    const iso = at.includes("T") ? at : at.replace(" ", "T");
    const withZ = iso.endsWith("Z") ? iso : `${iso}Z`;
    const d = new Date(withZ);
    time = Number.isNaN(d.getTime()) ? at : compactTimestamp(d);
  } else {
    time = compactTimestamp();
  }
  return `[Event: ${label}${time ? ` — ${time}` : ""}]\n`;
}

export function formatPrefix(meta: ChannelMeta | undefined, time: string): string {
  if (!meta?.channel && !meta?.sender) return "";
  const platform = meta.platform ?? "Volute";
  // Build sender context (e.g., "alice in DM" or "alice in #general in My Server")
  let sender = meta.sender ?? "";
  if (meta.isDM) {
    sender += " in DM";
  } else if (meta.channelName) {
    sender += ` in #${meta.channelName}`;
    if (meta.serverName) sender += ` in ${meta.serverName}`;
  }
  const parts = [platform, sender].filter(Boolean);
  // Include thread name if not the default
  const sessionPart =
    meta.sessionName && meta.sessionName !== "main" ? ` — thread: ${meta.sessionName}` : "";
  let prefix = parts.length > 0 ? `[${parts.join(": ")}${sessionPart} — ${time}]\n` : "";

  // Append participant profiles on first encounter per channel
  if (meta.participantProfiles && meta.participantProfiles.length > 0) {
    prefix += formatParticipantProfiles(meta.participantProfiles);
  }

  return prefix;
}

function formatParticipantProfiles(profiles: ParticipantProfile[]): string {
  const lines = profiles.map((p) => {
    const display = p.displayName ? ` (${p.displayName})` : "";
    const desc = p.description ? ` — ${p.description}` : "";
    return `  ${p.username}${display} [${p.userType}]${desc}`;
  });
  return `[Participants:\n${lines.join("\n")}]\n`;
}

export function formatTypingSuffix(typing: string[] | undefined): string {
  if (!typing || typing.length === 0) return "";
  if (typing.length === 1) return `\n[${typing[0]} is typing]`;
  return `\n[${typing.join(", ")} are typing]`;
}
