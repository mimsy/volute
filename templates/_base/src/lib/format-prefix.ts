import type { ChannelMeta } from "./types.js";

export function formatPrefix(meta: ChannelMeta | undefined, time: string): string {
  if (!meta?.channel && !meta?.sender) return "";
  // Use explicit platform name or capitalize from channel URI prefix
  const platform =
    meta.platform ??
    (() => {
      const n = (meta.channel ?? "").split(":")[0];
      return n.charAt(0).toUpperCase() + n.slice(1);
    })();
  // Build sender context (e.g., "alice in DM" or "alice in #general in My Server")
  let sender = meta.sender ?? "";
  if (meta.isDM) {
    sender += " in DM";
  } else if (meta.channelName) {
    sender += ` in #${meta.channelName}`;
    if (meta.guildName) sender += ` in ${meta.guildName}`;
  }
  const parts = [platform, sender].filter(Boolean);
  // Include session name if not the default
  const sessionPart =
    meta.sessionName && meta.sessionName !== "main" ? ` — session: ${meta.sessionName}` : "";
  return parts.length > 0 ? `[${parts.join(": ")}${sessionPart} — ${time}]\n` : "";
}
