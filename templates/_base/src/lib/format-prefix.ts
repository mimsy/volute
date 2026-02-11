import type { ChannelMeta } from "./types.js";

function derivePlatform(channel: string): string {
  const name = channel.split(":")[0];
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function formatPrefix(meta: ChannelMeta | undefined, time: string): string {
  if (!meta?.channel && !meta?.sender) return "";
  const platform = meta.platform ?? derivePlatform(meta.channel ?? "");
  // Build sender context (e.g., "alice in DM" or "alice in #general in My Server")
  let sender = meta.sender ?? "";
  if (meta.isDM) {
    sender += " in DM";
  } else if (meta.channelName) {
    sender += ` in #${meta.channelName}`;
    if (meta.serverName) sender += ` in ${meta.serverName}`;
  }
  const parts = [platform, sender].filter(Boolean);
  // Include session name if not the default
  const sessionPart =
    meta.sessionName && meta.sessionName !== "main" ? ` — session: ${meta.sessionName}` : "";
  return parts.length > 0 ? `[${parts.join(": ")}${sessionPart} — ${time}]\n` : "";
}
