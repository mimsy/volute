import { resolve } from "node:path";
import { and, like, ne } from "drizzle-orm";
import { getSpiritName } from "../config/setup.js";
import { dbPath, getDb } from "../db.js";
import { voluteSystemDir } from "../mind/registry.js";
import { users } from "../schema.js";
import { loadJsonMap, saveJsonMap } from "../util/json-state.js";
import log from "../util/logger.js";
import { alertHost } from "./system-events.js";

const clog = log.child("name-collisions");

/** The alert kind {@link alertHost} fans out for a squatted external-sender name. */
export const NAME_COLLISION_ALERT_KIND = "external_name_collision";

/** A Volute account holding a name in the `platform:handle` namespace. */
export type NameCollision = {
  id: number;
  username: string;
  /** `"human"`, `"mind"` or `"spirit"` — anything but a puppet, which owns these names. */
  userType: string;
};

/** Which accounts have already been alerted about, and when (epoch millis). */
function statePath(): string {
  return resolve(voluteSystemDir(), "external-name-collisions.json");
}

/**
 * Volute accounts squatting a name that belongs to the external-sender namespace.
 *
 * A `:` in a username means `platform:handle` (see `externalSenderName`), and only
 * puppets may hold one. `validateUsername` has refused colons since #1019, but an
 * account registered before that guard could take one, and such a row is fatal to
 * bridge inbound from whoever genuinely holds that handle: `findOrCreatePuppet`
 * selects on `user_type = "puppet"`, so it misses the row, and its insert then dies
 * on the UNIQUE constraint — identically, on every message, forever (#1023).
 */
export async function findExternalNameCollisions(): Promise<NameCollision[]> {
  const db = await getDb();
  const rows = await db
    .select({ id: users.id, username: users.username, userType: users.user_type })
    .from(users)
    .where(and(like(users.username, "%:%"), ne(users.user_type, "puppet")));
  return rows;
}

/**
 * What a host has to do about one colliding account.
 *
 * Volute has no account-rename command — not in the CLI, not in the API, which only
 * ever updates a profile — so this names the raw DB edit rather than inventing a
 * command that doesn't exist. Nothing here is done automatically: the account is a
 * person's, the name may be deliberate, and a silent rename would break their login.
 *
 * The SQL matches on `id`, and the name appears only JSON-quoted in prose. These rows
 * are by definition the ones that predate username validation, so the name may contain
 * anything at all — a quote, a newline, a shell metacharacter — and this text ends up
 * in front of a host and a mind that can both run commands. A name is never pasted
 * anywhere it would be executed or parsed.
 */
export function nameCollisionMessage(c: NameCollision): string {
  return (
    `The Volute account ${JSON.stringify(c.username)} (a ${c.userType} account, id ${c.id}) ` +
    `holds a name in the \`platform:handle\` namespace that external senders own. Messages ` +
    `from the platform user who genuinely holds that handle cannot be recorded — every one ` +
    `of them fails identically, and will keep failing until the account is renamed (#1023).\n\n` +
    `Nothing has been changed: renaming somebody's account is a host's decision, not the ` +
    `daemon's.\n\n` +
    `There is no \`volute\` command that renames an account — the profile commands change a ` +
    `display name, not a username. A host does it against the database directly, with the ` +
    `daemon stopped:\n\n` +
    `    sqlite3 ${dbPath()} "UPDATE users SET username = 'newname' WHERE id = ${c.id};"\n\n` +
    `That matches on the row id on purpose: the old name is not safe to paste into a shell.\n\n` +
    `Logins, conversations, DMs and API tokens all follow the row. Text already written with ` +
    `the old name does not: \`mind_history.sender\`, \`messages.sender_name\`, and any ` +
    `routes.json rule naming the account keep saying the old name.`
  );
}

/**
 * Warn about accounts squatting the external-sender namespace, at daemon start.
 *
 * The condition is static — it cannot resolve on its own, and it cannot arise on its own
 * either, since no new account can take a colon name — so boot is the whole of the useful
 * cadence; repeating it hourly would only be noise. The log line is for a host tailing the
 * journal, and is written on every start; `alertHost` is for the host who never tails it,
 * and reaches the spirit (which can relay it) and the dashboard as well.
 *
 * The alert is sent once per account, ever, recorded in a state file: it is an `immediate`
 * event, so an unrecorded one would run a spirit turn on every restart — a crash-looping
 * daemon would burn a turn per loop on a message nobody new is reading. The log line above
 * is not deduped: it is what a host reading the journal after the fact has to find.
 *
 * The alert goes to the spirit rather than to a mind because no one mind owns this
 * failure: it breaks inbound for every mind the affected bridge channel routes to.
 */
export async function reportExternalNameCollisions(): Promise<void> {
  const collisions = await findExternalNameCollisions();
  if (collisions.length === 0) return;

  const alerted = loadJsonMap(statePath());
  let changed = false;

  for (const c of collisions) {
    clog.warn(
      `the Volute account "${c.username}" (${c.userType}, id ${c.id}) holds a ` +
        `"platform:handle" name that belongs to external senders, so bridge messages from ` +
        `that handle fail permanently. No rename is done automatically — rename the row by ` +
        `hand (there is no volute command for it): ` +
        `sqlite3 ${dbPath()} "UPDATE users SET username = 'newname' WHERE id = ${c.id};"`,
      { username: c.username, userType: c.userType, id: c.id },
    );

    if (alerted.has(c.username)) continue;
    await alertHost(getSpiritName(), NAME_COLLISION_ALERT_KIND, nameCollisionMessage(c));
    alerted.set(c.username, Date.now());
    changed = true;
  }

  if (changed) saveJsonMap(statePath(), alerted);
}
