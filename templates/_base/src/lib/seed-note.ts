/**
 * The honest-boundary note injected on the first prompt/turn of a seeded session
 * (see the session seeders), plus the gap-duration clause the seeders enrich it
 * with. Shared across the claude, codex, and pi templates so the text stays
 * identical apart from the computed gap.
 */

/**
 * Base note, used verbatim when the gap can't be computed. The seeders enrich the
 * parenthetical with a coarse gap-duration clause via buildSeededNote().
 */
export const SEEDED_SESSION_NOTE_BASE =
  "Note: this session continues from your previous session's transcript (restored after archival). The conversation above happened before the break; a fresh session begins here.";

/**
 * Parse an archive-pointer timestamp into epoch millis, or null if it doesn't
 * match. The daemon's sleep-manager (archiveSessions) formats it as
 * `new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16)` → `YYYY-MM-DDTHH-MM`,
 * which is **UTC** and minute-precision, so we parse it back as UTC.
 */
export function parseArchiveTimestamp(ts: string): number | null {
  const m = ts.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})$/);
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return Number.isNaN(ms) ? null : ms;
}

/** Coarse human phrasing of a gap in millis: minutes, then hours, then days. */
function formatGap(ms: number): string | null {
  if (ms < 0) return null;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) return `about ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(ms / 86_400_000);
  return `about ${days} day${days === 1 ? "" : "s"}`;
}

/**
 * Build the seeded-session note, adding a coarse gap-duration clause when the
 * archived-at time is known. `archivedAtMs` is epoch millis from
 * parseArchiveTimestamp() (null → no clause); `nowMs` defaults to now so the gap
 * reflects when the mind actually reads the note.
 */
export function buildSeededNote(archivedAtMs: number | null, nowMs: number = Date.now()): string {
  if (archivedAtMs == null) return SEEDED_SESSION_NOTE_BASE;
  const gap = formatGap(nowMs - archivedAtMs);
  if (!gap) return SEEDED_SESSION_NOTE_BASE;
  return SEEDED_SESSION_NOTE_BASE.replace(
    "(restored after archival)",
    `(restored after archival; the break lasted ${gap})`,
  );
}
