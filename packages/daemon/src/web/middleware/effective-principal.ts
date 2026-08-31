import { isSystemSpirit } from "@volute/api/user-type";
import { and, eq, inArray } from "drizzle-orm";
import { getUserByUsername, type User } from "../../lib/auth.js";
import { getActiveTurnId } from "../../lib/daemon/turn-tracker.js";
import { getDb } from "../../lib/db.js";
import { mindHistory, turns } from "../../lib/schema.js";
import log from "../../lib/util/logger.js";
import { slugify } from "../../lib/util/slugify.js";

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
 * The one system-event kind that can make a spirit turn count as self-initiated.
 *
 * The test is not "did the daemon raise it" — the daemon raises nearly all of them.
 * It is **did the daemon author every word of it, with no untrusted party influencing
 * the content**. Almost no event kind passes that. `channel` is raised by the daemon
 * but fires whenever *anyone* messages a mind on an unrouted channel, and carries that
 * sender's name and message; `lifecycle` carries a sprouting seed's own display name;
 * `webhook` is a `requireSelf()` route whose entire body is the caller's. Each would
 * hand the spirit admin-equivalent authority on demand, with the asker's text as the
 * turn's content — which is exactly the escalation this file exists to close.
 *
 * A schedule's body comes from the mind's own `volute.json`, nowhere else. That it is
 * the *only* member is the point: this list should be read as a standing claim that
 * nothing else has been shown to be untainted, not as an inventory awaiting completion.
 * Widening it is a security decision and needs the same argument made for a new kind.
 *
 * Everything else resolves to `basic`, which is correct rather than merely safe: a wake
 * or version or budget event is the spirit attending to itself, and self-attention needs
 * no authority over anyone else. If a genuinely self-initiated path ever does need more,
 * the fix is to record the requesting principal on the event — real provenance — not to
 * add a kind here.
 *
 * Kinds come from `eventChannel()`: mind_history event rows are channelled
 * `event:<kind>:<id>` (system-events.ts), which is where this reads them from.
 */
const SELF_INITIATED_EVENT_KINDS = new Set(["schedule"]);

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

  // `getActiveTurnId` falls back to the sessionless `mind:*` slot, and every turn is
  // sessionless until `assignSession` re-keys it. Without this check any slug at all —
  // including one naming no session the spirit has ever had — resolves to whatever turn
  // happens to be mid-creation. Re-read the thread the daemon actually recorded and
  // require it to match the claim.
  let thread: string | null | undefined;
  try {
    const db = await getDb();
    thread = (
      await db.select({ thread: turns.thread }).from(turns).where(eq(turns.id, turnId)).get()
    )?.thread;
  } catch (err) {
    elog.warn(`failed to confirm turn thread for ${self}`, log.errorData(err));
    return BASIC(self);
  }
  // Both halves must be present, not merely equal: a request with no header during a
  // turn the daemon has not yet assigned a session to would otherwise match
  // undefined-to-null and resolve that turn's rows. Nothing legitimate needs it —
  // the spirit's CLI sends the header on every call, and a daemon-spawned script
  // never reaches here (it resolves above, on its token).
  if (!mindSession || !thread || thread !== mindSession) return BASIC(self);

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

  // Delegation happens in DMs and nowhere else.
  //
  // A `#channel` slug names no counterpart, so there is nothing on the row to check the
  // sender string against — and the issue's own design said channel sessions are least
  // privilege for exactly that reason. Anything that is not a DM resolves to `basic`.
  const channels = new Set(inbound.map((r) => r.channel));
  if (channels.size !== 1) return BASIC(self);
  const channel = [...channels][0];
  if (!channel?.startsWith("@")) return BASIC(self);

  const acting = await getUserByUsername(sender);
  // `users.username` is UNIQUE, so this is unambiguous — a mind and a human cannot
  // share a name. The spirit itself is excluded: borrowing your own authority is how
  // the standing superuser came back.
  if (!acting || acting.role === "pending" || isSystemSpirit(acting)) return BASIC(self);

  // A puppet is an external identity Volute never authenticated — a Discord or Slack
  // or Telegram account someone else's server vouched for, or an email `From`. It gets
  // a users row so it can appear in conversations, not so it can lend authority.
  if (acting.user_type === "puppet") return BASIC(self);

  // The load-bearing check, and the reason it works: on this same row, `channel` is
  // derived from the conversation's *participants* (`buildVoluteSlug` → the other
  // participant's username, and participants are `conversation_participants.user_id`),
  // while `sender` is a display string the delivery path was never asked to vouch for.
  // Bridge and mail inbound write the raw platform display name there, so a Discord
  // user who renames themselves `james` produces `sender: "james"` on a row whose
  // channel is `@discord-12345` — the puppet they actually are. Requiring the two to
  // agree is what stops a rename outside this system from becoming admin inside it.
  //
  // `slugify` is lossy (`Foo.Bar` and `foo_bar` both slug to `foo-bar`), so this is a
  // strong check rather than an exact one; two *registered* accounts colliding on a
  // slug could still pass. Namespacing external senders at the point of record (#1016)
  // is the independent second guarantee, and neither relies on the other.
  if (slugify(acting.username) !== channel.slice(1)) return BASIC(self);

  return {
    role: acting.role === "admin" ? "admin" : "user",
    scopes: [self, acting.username],
    actingFor: acting.username,
  };
}
