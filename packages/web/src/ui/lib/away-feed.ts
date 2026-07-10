/** localStorage key holding the ISO timestamp of the user's last home-feed visit. */
export const AWAY_SEEN_KEY = "volute:away-last-seen";

/**
 * Index in a newest-first feed where the "new since your last visit" divider
 * belongs: the first item at or older than `lastSeenMs`. Returns -1 when no
 * divider should show — no prior visit, nothing new (divider would sit at the
 * top), or everything new (divider would sit below the whole feed).
 */
export function dividerIndex(datesMs: number[], lastSeenMs: number | null): number {
  if (lastSeenMs == null) return -1;
  const idx = datesMs.findIndex((d) => d <= lastSeenMs);
  return idx <= 0 ? -1 : idx;
}
