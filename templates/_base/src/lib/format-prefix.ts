import type { ChannelInfo, ChannelMeta, ParticipantProfile } from "./types.js";

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
 * Prefix for a system-event turn: `=== System event: <label> — <local time> ===`.
 * Deliberately unlike every message prefix (bracketed, names a sender): an event comes
 * from the environment, has no sender, and cannot be replied to. The shape must not be
 * pattern-matchable to a message — a mind that reads it as one tries to reply to it.
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
  return `=== System event: ${label}${time ? ` — ${time}` : ""} ===\n`;
}

export function formatPrefix(meta: ChannelMeta | undefined, time: string): string {
  if (!meta?.channel && !meta?.sender) return "";
  const platform = meta.platform ?? "Volute";
  // Build the subject context. With a sender it's "alice in #general in My Server"; without one
  // this is a sender-less channel announcement (#687) — frame it by its channel and never invent
  // a name, so automated posts (e.g. #system "X has joined") aren't attributed to anyone.
  let subject: string;
  if (meta.sender) {
    subject = meta.sender;
    if (meta.isDM) {
      subject += " in DM";
    } else if (meta.channelName) {
      subject += ` in #${meta.channelName}`;
      if (meta.serverName) subject += ` in ${meta.serverName}`;
    }
  } else {
    subject = meta.channelName ? `#${meta.channelName}` : (meta.channel ?? "");
  }
  const parts = [platform, subject].filter(Boolean);
  // Include thread name if not the default
  const sessionPart =
    meta.sessionName && meta.sessionName !== "main" ? ` — thread: ${meta.sessionName}` : "";
  let prefix = parts.length > 0 ? `[${parts.join(": ")}${sessionPart} — ${time}]\n` : "";

  // Append participant profiles on first encounter per channel
  if (meta.participantProfiles && meta.participantProfiles.length > 0) {
    prefix += formatParticipantProfiles(meta.participantProfiles);
  }

  // ...and what the channel says about itself, on the same first encounter
  if (meta.channelInfo) {
    prefix += formatChannelInfo(meta.channelName ?? meta.channel, meta.channelInfo);
  }

  return prefix;
}

/**
 * The channel's own card: what it's for, its rules, and the limits its sends are held to.
 * Every line is optional — an unset field is omitted rather than shown as empty, and a channel
 * that has set nothing renders nothing at all.
 */
function formatChannelInfo(label: string | undefined, info: ChannelInfo): string {
  const lines: string[] = [];
  if (info.rules) lines.push(`  Rules: ${info.rules}`);

  const limits: string[] = [];
  if (info.charLimit) limits.push(`${info.charLimit} characters per message`);
  if (info.rateLimit && info.rateWindow) {
    limits.push(`${info.rateLimit} messages per ${info.rateWindow}s across the channel`);
  }
  if (limits.length > 0) lines.push(`  Limits: ${limits.join("; ")}`);

  const heading = label ? `#${label.replace(/^#/, "")}` : "Channel";
  const desc = info.description ? ` — ${info.description}` : "";
  if (lines.length === 0 && !info.description) return "";
  const body = lines.length > 0 ? `\n${lines.join("\n")}` : "";
  return `[${heading}${desc}${body}]\n`;
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
