export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Build a volute channel slug for a conversation.
 * DMs use `volute:@other-username`, groups use `volute:title`, fallback to `volute:conversationId`.
 */
export function buildVoluteSlug(opts: {
  participants: { username: string }[];
  mindUsername: string;
  convTitle: string | null | undefined;
  conversationId: string;
  convType?: "dm" | "channel";
  convName?: string | null;
}): string {
  if (opts.convType === "channel" && opts.convName) {
    return `volute:#${opts.convName}`;
  }
  const other = opts.participants.find((p) => p.username !== opts.mindUsername);
  const otherSlug = other ? slugify(other.username) : "";
  return otherSlug ? `volute:@${otherSlug}` : `volute:${opts.conversationId}`;
}
