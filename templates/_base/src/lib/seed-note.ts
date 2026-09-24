/**
 * The honest-boundary note injected on the first prompt/turn of a seeded session
 * (see the session seeders), plus the gap-duration clause the seeders enrich it
 * with. Shared across the claude, codex, and pi templates so the text stays
 * identical apart from the computed gap.
 */

/**
 * Why a session is presenting a seeded tail. `"restored"` — resumed from a
 * previous session's archived transcript (sleep/wake, restart). `"rotation"` —
 * rotated in place at the context limit, earlier turns collapsed. `"cold"` —
 * refreshed after a quiet stretch longer than the prompt cache lives (#1124). Each
 * gets its own note so the reader knows which boundary they've crossed.
 */
export type SeedCause = "restored" | "rotation" | "cold";

/**
 * Base note for the "restored" cause, used verbatim when the gap can't be computed.
 * buildSeededNote() enriches the parenthetical with a coarse gap-duration clause.
 */
export const SEEDED_SESSION_NOTE_BASE =
  "Note: this session continues from your previous session's transcript (restored after archival). The conversation above happened before the break; a fresh session begins here.";

/**
 * Note for the "rotation" cause. One line, low-salience by design: rotation is
 * meant to be near-invisible — no gap clause (the break is instantaneous), no
 * task, just an honest pointer to where the collapsed turns' summaries live.
 */
export const ROTATED_SESSION_NOTE =
  "Note: this session was consolidated at the context limit — the recent conversation above is kept verbatim (a long turn may be trimmed to its prompt and latest steps); summaries of older turns are in your history (`volute mind history`).";

/**
 * Appended to any cause's note when recall entries were actually seeded ahead of the
 * tail (claude template), so the note never claims recollection that isn't there.
 */
export const RECALL_NOTE_SUFFIX =
  " The [recall: …] entries before it are your consolidated memory of the days before, not a transcript.";

/**
 * Base note for the "cold" cause, used verbatim when the gap can't be computed.
 * buildSeededNote() enriches the parenthetical with how long the quiet lasted.
 */
export const COLD_SESSION_NOTE_BASE =
  "Note: this session was refreshed after a quiet stretch (you had been idle a while) — the recent conversation above is kept verbatim; summaries of older turns are in your history (`volute mind history`).";

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
 * Build the honest-boundary note for a seeded session, chosen by `cause`:
 *   - "rotation" → the rotation note (no gap clause).
 *   - "cold" → the cold-reset note, with the gap since the session's last activity
 *     (`archivedAtMs` is that time — the caller passes it, not the pointer's).
 *   - "restored" (default) → the restored note, enriched with a coarse
 *     gap-duration clause when `archivedAtMs` is known (epoch millis from
 *     parseArchiveTimestamp(); null → no clause). `nowMs` defaults to now so the
 *     gap reflects when the mind actually reads the note.
 * `recollection` (recall entries were seeded) appends RECALL_NOTE_SUFFIX.
 */
export function buildSeededNote(opts: {
  cause?: SeedCause;
  archivedAtMs?: number | null;
  nowMs?: number;
  recollection?: boolean;
}): string {
  const suffix = opts.recollection ? RECALL_NOTE_SUFFIX : "";
  if (opts.cause === "rotation") return ROTATED_SESSION_NOTE + suffix;
  const base = opts.cause === "cold" ? COLD_SESSION_NOTE_BASE : SEEDED_SESSION_NOTE_BASE;
  const archivedAtMs = opts.archivedAtMs ?? null;
  const gap = archivedAtMs == null ? null : formatGap((opts.nowMs ?? Date.now()) - archivedAtMs);
  if (!gap) return base + suffix;
  if (opts.cause === "cold") {
    return base.replace("(you had been idle a while)", `(the quiet lasted ${gap})`) + suffix;
  }
  return (
    base.replace(
      "(restored after archival)",
      `(restored after archival; the break lasted ${gap})`,
    ) + suffix
  );
}
