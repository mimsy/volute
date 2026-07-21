import type { Database } from "@volute/extensions";

/** Hard cap on active intentions per mind, enforced at the API layer (routes.ts/commands.ts). */
export const MAX_ACTIVE_INTENTIONS = 3;

/** Default soft-review window: how many days out review_at is set on create/keep. */
export const DEFAULT_REVIEW_DAYS = 14;

/** Default outreach backoff: how long since last_surfaced_at before review-due surfaces it again. */
export const DEFAULT_BACKOFF_DAYS = 7;

/** content is a single short line — enforced at the API layer. */
export const MAX_CONTENT_LENGTH = 240;

export type IntentionStatus = "active" | "fulfilled" | "released";

export type Intention = {
  id: number;
  mind_name: string;
  content: string;
  note: string | null;
  status: IntentionStatus;
  created_at: string;
  review_at: string;
  last_surfaced_at: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
};

/**
 * An intention with display fields computed by SQLite rather than parsed back into
 * JS. `created_at`/`review_at` are zone-less UTC text ("YYYY-MM-DD HH:MM:SS"), and
 * `new Date(row.created_at)` would misparse them as local time (a recurring bug in
 * this codebase — see parseDbTimestamp() in packages/daemon). Doing the age/overdue
 * arithmetic in SQL (which treats datetime('now') and stored values as the same UTC
 * clock) sidesteps that class of bug entirely instead of relying on every caller to
 * remember a JS-side parser.
 */
export type IntentionWithMeta = Intention & { held_days: number; overdue: boolean };

function withMeta(
  rows: (Intention & { held_days: number; overdue: number })[],
): IntentionWithMeta[] {
  return rows.map((row) => ({ ...row, overdue: !!row.overdue }));
}

const META_COLUMNS = `
  CAST((julianday('now') - julianday(created_at)) AS INTEGER) AS held_days,
  CASE WHEN status = 'active' AND review_at <= datetime('now') THEN 1 ELSE 0 END AS overdue
`;

export function countActive(db: Database, mindName: string): number {
  const row = db
    .prepare("SELECT COUNT(*) as count FROM intentions WHERE mind_name = ? AND status = 'active'")
    .get(mindName) as { count: number };
  return row.count;
}

export function createIntention(
  db: Database,
  mindName: string,
  content: string,
  note: string | undefined,
  reviewInDays: number | undefined,
): Intention {
  const days = reviewInDays && reviewInDays > 0 ? reviewInDays : DEFAULT_REVIEW_DAYS;
  return db
    .prepare(
      `INSERT INTO intentions (mind_name, content, note, review_at)
       VALUES (?, ?, ?, datetime('now', ?))
       RETURNING *`,
    )
    .get(mindName, content, note ?? null, `+${days} days`) as Intention;
}

export function getIntention(db: Database, id: number): Intention | null {
  return (
    (db.prepare("SELECT * FROM intentions WHERE id = ?").get(id) as Intention | undefined) ?? null
  );
}

/** The board: all intentions matching a status (default 'active'), optionally filtered by mind. */
export function listBoard(
  db: Database,
  opts?: { mind?: string; status?: string; limit?: number },
): IntentionWithMeta[] {
  const status = opts?.status ?? "active";
  const conditions = ["status = ?"];
  const params: unknown[] = [status];
  if (opts?.mind) {
    conditions.push("mind_name = ?");
    params.push(opts.mind);
  }
  const limitClause = opts?.limit ? " LIMIT ?" : "";
  if (opts?.limit) params.push(opts.limit);

  const rows = db
    .prepare(
      `SELECT *, ${META_COLUMNS} FROM intentions WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC${limitClause}`,
    )
    .all(...params) as (Intention & { held_days: number; overdue: number })[];
  return withMeta(rows);
}

/** A mind's own active intentions — what the pre-prompt hook and `volute intention list` read. */
export function listMine(db: Database, mindName: string): IntentionWithMeta[] {
  const rows = db
    .prepare(
      `SELECT *, ${META_COLUMNS} FROM intentions WHERE mind_name = ? AND status = 'active' ORDER BY created_at ASC`,
    )
    .all(mindName) as (Intention & { held_days: number; overdue: number })[];
  return withMeta(rows);
}

/** Bump review_at by the default window and clear the outreach backoff. */
export function keepIntention(db: Database, id: number): Intention | null {
  return (
    (db
      .prepare(
        `UPDATE intentions
         SET review_at = datetime('now', ?), last_surfaced_at = NULL
         WHERE id = ? AND status = 'active'
         RETURNING *`,
      )
      .get(`+${DEFAULT_REVIEW_DAYS} days`, id) as Intention | undefined) ?? null
  );
}

function resolveStatus(
  db: Database,
  id: number,
  status: "fulfilled" | "released",
  note: string | undefined,
): Intention | null {
  return (
    (db
      .prepare(
        `UPDATE intentions
         SET status = ?, resolved_at = datetime('now'), resolution_note = ?
         WHERE id = ? AND status = 'active'
         RETURNING *`,
      )
      .get(status, note ?? null, id) as Intention | undefined) ?? null
  );
}

export function fulfillIntention(db: Database, id: number, note?: string): Intention | null {
  return resolveStatus(db, id, "fulfilled", note);
}

export function releaseIntention(db: Database, id: number, note?: string): Intention | null {
  return resolveStatus(db, id, "released", note);
}

/**
 * Active intentions past review_at, excluding anything surfaced within the backoff
 * window. Marks each returned row's last_surfaced_at — regardless of whether the
 * mind ever responds — which is what prevents nagging (see skills/intention-review).
 */
export function listReviewDue(
  db: Database,
  backoffDays = DEFAULT_BACKOFF_DAYS,
): IntentionWithMeta[] {
  const rows = db
    .prepare(
      `SELECT *, ${META_COLUMNS} FROM intentions
       WHERE status = 'active'
         AND review_at <= datetime('now')
         AND (last_surfaced_at IS NULL OR last_surfaced_at <= datetime('now', ?))
       ORDER BY review_at ASC`,
    )
    .all(`-${backoffDays} days`) as (Intention & { held_days: number; overdue: number })[];

  if (rows.length > 0) {
    const stmt = db.prepare(
      "UPDATE intentions SET last_surfaced_at = datetime('now') WHERE id = ?",
    );
    for (const row of rows) stmt.run(row.id);
  }

  return withMeta(rows);
}
