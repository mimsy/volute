import { isSystemSpirit } from "@volute/api/user-type";
import { and, eq, inArray } from "drizzle-orm";
import { getUserByUsername, type User } from "../../lib/auth.js";
import { getActiveTurnId } from "../../lib/daemon/turn-tracker.js";
import { getDb } from "../../lib/db.js";
import { mindHistory } from "../../lib/schema.js";
import log from "../../lib/util/logger.js";

const elog = log.child("effective-principal");

/**
 * Authority tier a request runs at, distinct from the `role` column on `users`.
 *
 * Kept out of `User["role"]` on purpose: `basic` and `system` are properties of a
 * *request*, never of a stored account, so putting them in the DB union would
 * invite a row to be written with one.
 *
 * - `admin`  — a real admin, or the spirit acting on behalf of a verified admin.
 * - `user`   — an ordinary principal, or the spirit acting on behalf of one.
 * - `system` — the spirit's own self-initiated work (a schedule fire, a
 *              daemon-spawned script). It clears `requireSelf` and the privileged
 *              reads, and deliberately NOT `requireAdmin`: the spirit configures its
 *              own schedules, so anything gated only on `system` is, for the spirit,
 *              gated on nothing.
 * - `basic`  — least privilege. The spirit with no verifiable requesting
 *              principal: it can still act on itself, and nothing else.
 */
export type EffectiveRole = "system" | "admin" | "user" | "basic";

export type Effective = {
  role: EffectiveRole;
  /**
   * Usernames whose own-scoped data this request may reach (see `requireSelf`).
   * `scopes[0]` is always the caller itself.
   *
   * Delegation *adds* a scope, it does not replace one: the spirit acting for
   * someone else keeps its own name here, because a turn spent on your behalf is
   * still a turn in which it has to post its own events and read its own history.
   */
  scopes: string[];
  /** Username whose authority the spirit is borrowing, when it is borrowing one. */
  actingFor?: string;
};

const BASIC = (self: string): Effective => ({ role: "basic", scopes: [self] });

/**
 * System-event kinds the daemon raises on its own initiative, and the only ones that
 * can make a turn count as self-initiated.
 *
 * This is an allowlist because the alternative fails open. `POST /:name/webhook/:event`
 * is `requireSelf()`, so a spirit running at `basic` passes it on itself, and it writes
 * an event row with a null sender exactly like a schedule fire does. Reading "event
 * rows, no inbound" as "nobody asked for this" would hand that spirit a one-request
 * round trip from `basic` back to `system` — with an attacker-supplied body as the
 * turn's content. So a kind any principal can trigger on demand must never appear here,
 * and a kind not listed resolves to `basic`: a tending path that stops working is a
 * visible bug, an escalation that starts working is not.
 *
 * Kinds come from `eventChannel()` — mind_history event rows are channelled
 * `event:<kind>:<id>` (system-events.ts), which is where this reads them from.
 */
const SELF_INITIATED_EVENT_KINDS = new Set([
  "backup",
  "budget",
  "channel",
  "farewell",
  "lifecycle",
  "notice",
  "orientation",
  "schedule",
  "sleep",
  "version",
  "wake",
]);

/** Test seam: the allowlist above, so a test can pin what is and isn't in it. */
export const _selfInitiatedEventKinds = SELF_INITIATED_EVENT_KINDS;

/** `event:<kind>:<id>` → `<kind>`. */
function eventKind(channel: string | null): string | undefined {
  if (!channel?.startsWith("event:")) return undefined;
  return channel.slice("event:".length).split(":")[0] || undefined;
}

/** Admin-equivalent authority — a real admin, or the spirit's self-initiated work. */
export function hasSystemAuthority(e: Effective | undefined): boolean {
  return e?.role === "admin" || e?.role === "system";
}

/** Strict admin authority. Self-initiated spirit work is deliberately excluded. */
export function hasAdminAuthority(e: Effective | undefined): boolean {
  return e?.role === "admin";
}

/**
 * Resolve the authority a request actually runs at.
 *
 * Everyone but the spirit gets exactly their own role and their own scope — this is
 * a no-op for humans, minds, and the daemon token.
 *
 * The spirit is the reason this exists. It authenticates as the shared system user,
 * and *anyone can talk to it*: every mind has a system DM, humans DM it, it reads
 * #system. As a standing superuser that made it a straight escalation path from "any
 * mind can send text" to admin-equivalent API access (#433). Here it instead borrows
 * the authority of whoever triggered the turn its request arrives in — capped at that
 * principal's real role, so nobody gains anything by asking the spirit instead of
 * asking directly.
 *
 * The acting principal comes from the daemon's own turn tracker and the senders the
 * daemon recorded on that turn — never from the session slug the spirit self-reports.
 * The slug only *selects among* genuinely-active turns; it cannot invent one. Every
 * unresolvable case falls to `basic`, so the failure mode is a 403, not an
 * escalation.
 */
export async function resolveEffective(principal: {
  user: User;
  mindSession?: string;
  viaScript?: boolean;
}): Promise<Effective> {
  const { user, mindSession, viaScript } = principal;
  const self = user.username;

  if (!isSystemSpirit(user)) {
    // "pending" never reaches a guard (authMiddleware turns it away first), but map
    // it to basic rather than leaking a non-EffectiveRole value into a comparison.
    const role: EffectiveRole = user.role === "pending" ? "basic" : (user.role as EffectiveRole);
    return { role, scopes: [self] };
  }

  // A script the daemon spawned for the spirit is self-initiated by construction:
  // the credential was minted for a process the daemon started, not claimed by the
  // spirit's own env. This is checked before any session lookup — a script inherits
  // a stale session file often enough that resolving it turn-wise would 403 the
  // nurture flow whenever an unrelated DM turn happened to be running.
  if (viaScript) return { role: "system", scopes: [self] };

  const turnId = getActiveTurnId(self, mindSession);
  if (!turnId) return BASIC(self);

  let rows: { type: string; sender: string | null; channel: string | null }[];
  try {
    const db = await getDb();
    rows = await db
      .select({
        type: mindHistory.type,
        sender: mindHistory.sender,
        channel: mindHistory.channel,
      })
      .from(mindHistory)
      .where(and(eq(mindHistory.turn_id, turnId), inArray(mindHistory.type, ["inbound", "event"])));
  } catch (err) {
    elog.warn(`failed to resolve acting principal for ${self}`, log.errorData(err));
    return BASIC(self);
  }

  // Positive evidence only. `linkPendingInbound` is warn-and-continue, so a turn can
  // legitimately end up with nothing attributed to it — and a user-triggered turn
  // whose linking failed looks exactly like a schedule fire if you read "no inbound
  // rows" as "self-initiated". Require a linked system event to say system.
  if (rows.length === 0) return BASIC(self);

  const inbound = rows.filter((r) => r.type === "inbound");
  if (inbound.length === 0) {
    const kinds = rows.map((r) => eventKind(r.channel));
    const daemonRaised = kinds.every((k) => k && SELF_INITIATED_EVENT_KINDS.has(k));
    return daemonRaised ? { role: "system", scopes: [self] } : BASIC(self);
  }

  // More than one distinct sender in the turn drops to basic. `linkInboundToActiveTurn`
  // folds messages that arrive mid-turn into the running turn, so without this an
  // admin's DM turn would lend its authority to whatever a non-admin said into it
  // while it ran. Per-message attribution would be tighter, but a CLI request carries
  // only a session — never a message id — so there is nothing to attribute it *to*.
  const senders = new Set(inbound.map((r) => r.sender));
  if (senders.size !== 1) return BASIC(self);
  const sender = [...senders][0];
  if (!sender) return BASIC(self);

  const acting = await getUserByUsername(sender);
  // `users.username` is UNIQUE, so this is unambiguous — a mind and a human cannot
  // share a name. The spirit itself is excluded: borrowing your own authority is how
  // the standing superuser came back.
  if (!acting || acting.role === "pending" || isSystemSpirit(acting)) return BASIC(self);

  return {
    role: acting.role === "admin" ? "admin" : "user",
    scopes: [self, acting.username],
    actingFor: acting.username,
  };
}
