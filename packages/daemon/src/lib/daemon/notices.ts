import { and, asc, eq, lte, sql } from "drizzle-orm";
import { getDb } from "../db.js";
import { mindNotices } from "../schema.js";
import log from "../util/logger.js";
import type { ErrorReason } from "./error-classify.js";

const nlog = log.child("notices");

export type NoticeKind = "turn_error" | "crash" | "budget";

/** The full closed set of reasons; each kind constrains which reasons are legal. */
export type NoticeReason = ErrorReason | "process_crash" | "token_budget";

/**
 * A notice to record. The union ties `kind` to its legal `reason`(s), so e.g.
 * `{ kind: "crash", reason: "auth_error" }` won't typecheck.
 */
export type RecordNoticeInput = {
  mind: string;
  session: string;
  detail: string;
  raw?: string | null;
} & (
  | { kind: "turn_error"; reason: ErrorReason }
  | { kind: "crash"; reason: "process_crash" }
  | { kind: "budget"; reason: "token_budget" }
);

/** A persisted notice row (kind/reason narrowed via the schema column $type). */
export type Notice = typeof mindNotices.$inferSelect;

/** Max undelivered notices retained per (mind, session) — bounds growth if a session
 *  never recovers (or a mind has no drain hook). The drain shows at most this many. */
const MAX_NOTICES_PER_SESSION = 100;

/** Record a failure notice for a mind+session. Never throws — logs and returns. */
export async function recordNotice(input: RecordNoticeInput): Promise<void> {
  try {
    const db = await getDb();
    await db.insert(mindNotices).values({
      mind: input.mind,
      session: input.session,
      kind: input.kind,
      reason: input.reason,
      detail: input.detail,
      raw: input.raw ?? null,
    });
    // Trim to the most recent N for this session so an outage that never recovers
    // can't grow the table without bound.
    await db.run(
      sql`DELETE FROM mind_notices WHERE mind = ${input.mind} AND session = ${input.session} AND id NOT IN (SELECT id FROM mind_notices WHERE mind = ${input.mind} AND session = ${input.session} ORDER BY id DESC LIMIT ${MAX_NOTICES_PER_SESSION})`,
    );
  } catch (err) {
    // A persistent failure here (e.g. migration 0009 not applied) silently disables
    // the whole feature, so log at error — this is a real defect, not benign noise.
    nlog.error(`failed to record notice for ${input.mind}:${input.session}`, log.errorData(err));
  }
}

/** Undelivered notices for a mind+session, oldest first (by monotonic id). */
export async function drainNotices(
  mind: string,
  session: string,
  limit = MAX_NOTICES_PER_SESSION,
): Promise<Notice[]> {
  const db = await getDb();
  return db
    .select()
    .from(mindNotices)
    .where(and(eq(mindNotices.mind, mind), eq(mindNotices.session, session)))
    .orderBy(asc(mindNotices.id))
    .limit(limit);
}

/**
 * Delete delivered notices for a mind+session, up to and including `uptoId`.
 * Bounding by id ensures a notice created mid-turn (e.g. a budget notice during an
 * otherwise-clean turn, with id > the drained watermark) isn't removed before the mind
 * has read it — it survives to be drained on the next turn. Delete (rather than a
 * delivered flag) keeps the table a bounded delivery queue.
 */
export async function clearDeliveredNotices(
  mind: string,
  session: string,
  uptoId: number,
): Promise<void> {
  try {
    const db = await getDb();
    await db
      .delete(mindNotices)
      .where(
        and(
          eq(mindNotices.mind, mind),
          eq(mindNotices.session, session),
          lte(mindNotices.id, uptoId),
        ),
      );
  } catch (err) {
    nlog.warn(`failed to clear delivered notices for ${mind}:${session}`, log.errorData(err));
  }
}

const NOTICE_HEADER =
  "[Notices] While you were unavailable, one or more turns failed. You're back now:";

/**
 * Render notices as a context block, grouping identical reasons into one line with a
 * count and time range so an outage of many identical failures stays readable while
 * still conveying the full scope. Returns null for an empty list.
 */
export function formatNotices(notices: Notice[]): string | null {
  if (notices.length === 0) return null;

  const groups = new Map<string, { count: number; detail: string; first: string; last: string }>();
  for (const n of notices) {
    const time = localHM(n.created_at);
    const g = groups.get(n.reason);
    if (g) {
      g.count += 1;
      g.detail = n.detail;
      g.last = time;
    } else {
      groups.set(n.reason, { count: 1, detail: n.detail, first: time, last: time });
    }
  }

  const lines = [...groups.values()].map((g) => {
    const span = g.first === g.last ? g.first : `${g.first}–${g.last}`;
    const plural = g.count === 1 ? "turn" : "turns";
    return `- ${g.count} ${plural} failed (${span}): ${g.detail}`;
  });
  return `${NOTICE_HEADER}\n${lines.join("\n")}`;
}

/**
 * Format a stored `created_at` (UTC, `YYYY-MM-DD HH:MM:SS`) as 24-hour HH:MM in the
 * daemon's local timezone — what the mind sees elsewhere, so no UTC math is needed.
 */
function localHM(createdAt: string): string {
  const iso = createdAt.endsWith("Z") ? createdAt : `${createdAt.replace(" ", "T")}Z`;
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}
