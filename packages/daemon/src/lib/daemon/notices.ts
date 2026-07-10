import { and, asc, desc, eq, gt, inArray, lte, or, sql } from "drizzle-orm";
import { getDb } from "../db.js";
import { mindNotices, turns } from "../schema.js";
import log from "../util/logger.js";
import type { ErrorReason } from "./error-classify.js";

const nlog = log.child("notices");

export type NoticeKind = "turn_error" | "crash" | "budget" | "startup" | "extension";

/** The full closed set of reasons; each kind constrains which reasons are legal.
 *  For `extension` notices the reason is the extension id (an arbitrary string). */
export type NoticeReason =
  | ErrorReason
  | "process_crash"
  | "token_budget"
  | "startup_failed"
  | (string & {});

/** Sentinel session for mind-level notices that aren't tied to a specific session.
 *  Drained into whichever session next runs a clean turn. */
export const MIND_LEVEL_SESSION = "";

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
  | { kind: "startup"; reason: "startup_failed" | "no_credentials" }
  | { kind: "extension"; reason: string }
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

/**
 * Undelivered notices for a mind+session, oldest first (by monotonic id).
 * Includes mind-level notices (session = "") so they reach whichever session
 * next runs a turn.
 */
export async function drainNotices(
  mind: string,
  session: string,
  limit = MAX_NOTICES_PER_SESSION,
): Promise<Notice[]> {
  const db = await getDb();
  return db
    .select()
    .from(mindNotices)
    .where(
      and(
        eq(mindNotices.mind, mind),
        or(eq(mindNotices.session, session), eq(mindNotices.session, MIND_LEVEL_SESSION)),
      ),
    )
    .orderBy(asc(mindNotices.id))
    .limit(limit);
}

/** Notice kinds that represent failures (as opposed to budget pauses or extension chatter). */
const FAILURE_KINDS = ["turn_error", "crash", "startup"] as const;

export type FailureNotice = {
  kind: "turn_error" | "crash" | "startup";
  reason: string;
  detail: string;
  at: string;
};

// A persistent read failure silently disables the #574 status surface for every
// mind (same defect class recordNotice logs at error), but this runs on every
// minds-list fetch — log once per process instead of spamming.
let failureReadErrorLogged = false;

/**
 * The most recent failure notice for a mind with no turn completed since,
 * across all sessions. Budget and extension notices don't count — they aren't
 * failures. (The table is a delete-on-clear queue, so rows are pending by
 * construction; don't add a "delivered" filter.)
 *
 * Notice deletion is per-session (a session must drain the notice and then run
 * a clean turn), so a failure in a session that never runs again would linger
 * forever. The completed-turn check bounds that: any turn completed after the
 * notice means the mind is demonstrably able to finish turns, so chat stops
 * showing the failure (#574). A turn that errors records a fresh notice, which
 * postdates that turn's own row and keeps the signal up.
 *
 * Returns null on DB errors: status enrichment must not take down the minds list.
 */
export async function latestFailureNotice(mind: string): Promise<FailureNotice | null> {
  try {
    const db = await getDb();
    const rows = await db
      .select()
      .from(mindNotices)
      .where(and(eq(mindNotices.mind, mind), inArray(mindNotices.kind, [...FAILURE_KINDS])))
      .orderBy(desc(mindNotices.id))
      .limit(1);
    const n = rows[0];
    if (!n) return null;

    const recovered = await db
      .select({ id: turns.id })
      .from(turns)
      .where(
        and(eq(turns.mind, mind), eq(turns.status, "complete"), gt(turns.created_at, n.created_at)),
      )
      .limit(1);
    if (recovered.length > 0) return null;

    return {
      kind: n.kind as FailureNotice["kind"],
      reason: n.reason,
      detail: n.detail,
      at: n.created_at,
    };
  } catch (err) {
    if (!failureReadErrorLogged) {
      failureReadErrorLogged = true;
      nlog.error(`failed to read latest failure notice for ${mind}`, log.errorData(err));
    }
    return null;
  }
}

/**
 * The most recent undelivered notice for a mind across all sessions, or null.
 * Every row in the table is undelivered (delivered notices are deleted), so the
 * highest-id row is the latest issue. Used by `mind status` to surface the newest
 * failure without the mind having to drain it.
 */
export async function latestNotice(mind: string): Promise<Notice | null> {
  const db = await getDb();
  const row = await db
    .select()
    .from(mindNotices)
    .where(eq(mindNotices.mind, mind))
    .orderBy(desc(mindNotices.id))
    .limit(1)
    .get();
  return row ?? null;
}

/** True if the mind has an undelivered notice with this reason (any session). */
export async function hasUndeliveredNotice(mind: string, reason: NoticeReason): Promise<boolean> {
  const db = await getDb();
  const row = await db
    .select({ id: mindNotices.id })
    .from(mindNotices)
    .where(and(eq(mindNotices.mind, mind), eq(mindNotices.reason, reason)))
    .limit(1)
    .get();
  return row != null;
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
          or(eq(mindNotices.session, session), eq(mindNotices.session, MIND_LEVEL_SESSION)),
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
 * Render notices as a context block. Failure notices (turn errors, crashes, startup)
 * group identical reasons into one line with a count and time range so an outage of
 * many identical failures stays readable. Budget notices get their own block — a
 * budget pause is not a failure. Extension notices (comments, reactions, etc.) render
 * verbatim, one line each with their time, under a per-extension header. Returns null
 * for an empty list.
 */
export function formatNotices(notices: Notice[]): string | null {
  if (notices.length === 0) return null;

  const failures = notices.filter((n) => n.kind !== "extension" && n.kind !== "budget");
  const budgets = notices.filter((n) => n.kind === "budget");
  const extensions = notices.filter((n) => n.kind === "extension");

  const blocks: string[] = [];

  if (failures.length > 0) {
    const groups = new Map<
      string,
      { count: number; detail: string; first: string; last: string }
    >();
    for (const n of failures) {
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
    blocks.push(`${NOTICE_HEADER}\n${lines.join("\n")}`);
  }

  if (budgets.length > 0) {
    const lines = budgets.map((n) => `- ${localHM(n.created_at)} ${n.detail}`);
    blocks.push(`[Budget]\n${lines.join("\n")}`);
  }

  if (extensions.length > 0) {
    // Group by reason (the extension id), preserving oldest-first order within each.
    const byExt = new Map<string, Notice[]>();
    for (const n of extensions) {
      const arr = byExt.get(n.reason);
      if (arr) arr.push(n);
      else byExt.set(n.reason, [n]);
    }
    for (const [ext, items] of byExt) {
      const header = `[${ext.charAt(0).toUpperCase()}${ext.slice(1)}]`;
      const lines = items.map((n) => `- ${localHM(n.created_at)} ${n.detail}`);
      blocks.push(`${header}\n${lines.join("\n")}`);
    }
  }

  return blocks.join("\n\n");
}

/**
 * Format a stored `created_at` (UTC, `YYYY-MM-DD HH:MM:SS`) as 24-hour HH:MM in the
 * daemon's local timezone — what the mind sees elsewhere, so no UTC math is needed.
 */
function localHM(createdAt: string): string {
  const iso = createdAt.endsWith("Z") ? createdAt : `${createdAt.replace(" ", "T")}Z`;
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}
