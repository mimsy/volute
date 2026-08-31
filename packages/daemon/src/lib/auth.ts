import { isMind, isSystemSpirit, type UserType } from "@volute/api/user-type";
import { compareSync, hashSync } from "bcryptjs";
import { and, count, eq, inArray, or } from "drizzle-orm";
import { getSpiritName } from "./config/setup.js";
import { getDb } from "./db.js";
import { broadcast } from "./events/activity-events.js";
import { findMind, isSpiritName } from "./mind/registry.js";
import type { MindProfile } from "./mind/volute-config.js";
import { users } from "./schema.js";

export type User = {
  id: number;
  username: string;
  role: "admin" | "user" | "pending" | "spirit";
  // The canonical union from the schema, not a hand-copied subset. It used to omit
  // "puppet" — which every bridge stand-in actually is — so `user.user_type === "puppet"`
  // typechecked as *impossible* while being routinely true at runtime, and TS would
  // reject a guard against the one identity Volute never authenticated (#433).
  user_type: UserType;
  display_name: string | null;
  description: string | null;
  avatar: string | null;
  created_at: string;
};

const userSelectFields = {
  id: users.id,
  username: users.username,
  role: users.role,
  user_type: users.user_type,
  display_name: users.display_name,
  description: users.description,
  avatar: users.avatar,
  created_at: users.created_at,
};

// The same charset `validateMindName` enforces for minds (registry.ts). Humans, minds and
// puppets share one `users.username` column, and a mind reads all three the same way.
const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const USERNAME_MAX = 64;

/**
 * Validate a human username. An allowlist, deliberately, not a `:` blocklist.
 *
 * Two things rest on this. External senders — bridge puppets, mail, the cloud relay —
 * are recorded under a namespaced `platform:identifier` handle, so that a *bare* name in
 * a sender column means an authenticated Volute user and nothing else (#1016); that holds
 * only while no Volute username can carry the `:` separator. And a username is
 * interpolated into the framing a mind reads as system-rendered — the `[Volute: <sender>
 * in DM — <time>]` prefix and the `[Participants: …]` block (`format-prefix.ts`) — so a
 * name containing a newline or brackets forges that frame. That is the same impersonation
 * the namespacing closes, one layer up: a sender who can forge the frame around their own
 * message doesn't need to forge the name inside it.
 *
 * Mind names were already validated this way; human registration accepted any non-empty
 * string, leaving both holes open from the human side.
 *
 * Returns an error message, or null when the name is acceptable.
 */
export function validateUsername(username: string): string | null {
  if (!username) return "Username is required";
  if (username.length > USERNAME_MAX) {
    return `Username must be at most ${USERNAME_MAX} characters`;
  }
  if (username.includes(":")) {
    return 'Username may not contain ":" — that separator is reserved for external identities (e.g. "discord:alice")';
  }
  if (!USERNAME_RE.test(username)) {
    return "Username must start with a letter or number and contain only letters, numbers, dots, dashes, or underscores";
  }
  return null;
}

export async function createUser(username: string, password: string): Promise<User> {
  const db = await getDb();
  const hash = hashSync(password, 10);

  // First human user becomes admin automatically
  const [{ value }] = await db
    .select({ value: count() })
    .from(users)
    .where(eq(users.user_type, "human"));
  const role = value === 0 ? "admin" : "pending";

  const [result] = await db
    .insert(users)
    .values({ username, password_hash: hash, role })
    .returning(userSelectFields);

  return result as User;
}

export async function verifyUser(username: string, password: string): Promise<User | null> {
  const db = await getDb();
  const row = await db.select().from(users).where(eq(users.username, username)).get();
  if (!row) return null;
  if (isMind(row) || isSystemSpirit(row)) return null; // minds and the spirit can't log in
  if (!compareSync(password, row.password_hash)) return null;
  const { password_hash: _, ...user } = row;
  return user as User;
}

export async function getUser(id: number): Promise<User | null> {
  const db = await getDb();
  const row = await db.select(userSelectFields).from(users).where(eq(users.id, id)).get();
  return (row as User) ?? null;
}

/**
 * Resolve display names for a set of usernames.
 * Returns a map of username → display_name, omitting users without a display name.
 * Used to render "Display Name (@username)" in human-facing output.
 */
export async function getDisplayNames(usernames: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(usernames.filter((u): u is string => !!u))];
  const map = new Map<string, string>();
  if (unique.length === 0) return map;
  const db = await getDb();
  const rows = await db
    .select({ username: users.username, displayName: users.display_name })
    .from(users)
    .where(inArray(users.username, unique));
  for (const r of rows) {
    if (r.displayName) map.set(r.username, r.displayName);
  }
  return map;
}

/**
 * Annotate messages with the sender's display name (resolved from the users
 * table) so human-facing clients can render "Display Name (@username)".
 */
export async function withSenderDisplayNames<T extends { sender_name: string | null }>(
  msgs: T[],
): Promise<(T & { sender_display_name: string | null })[]> {
  const displayNames = await getDisplayNames(msgs.map((m) => m.sender_name));
  return msgs.map((m) => ({
    ...m,
    sender_display_name: m.sender_name ? (displayNames.get(m.sender_name) ?? null) : null,
  }));
}

export async function getUserByUsername(username: string): Promise<User | null> {
  const db = await getDb();
  const row = await db
    .select(userSelectFields)
    .from(users)
    .where(eq(users.username, username))
    .get();
  return (row as User) ?? null;
}

export async function listUsers(): Promise<User[]> {
  const db = await getDb();
  return db.select(userSelectFields).from(users).orderBy(users.created_at).all() as Promise<User[]>;
}

export async function listPendingUsers(): Promise<User[]> {
  const db = await getDb();
  return db
    .select(userSelectFields)
    .from(users)
    .where(eq(users.role, "pending"))
    .orderBy(users.created_at)
    .all() as Promise<User[]>;
}

export async function listUsersByType(userType: "human" | "mind"): Promise<User[]> {
  const db = await getDb();
  return db
    .select(userSelectFields)
    .from(users)
    .where(eq(users.user_type, userType))
    .orderBy(users.created_at)
    .all() as Promise<User[]>;
}

export async function getOrCreateMindUser(mindName: string): Promise<User> {
  // The spirit reuses the system user — route through getOrCreateSystemUser so a
  // freshly named spirit never mints a second, mind-typed user.
  if (isSpiritName(mindName)) return getOrCreateSystemUser();

  const db = await getDb();
  const existing = await db
    .select(userSelectFields)
    .from(users)
    .where(
      and(
        eq(users.username, mindName),
        or(eq(users.user_type, "mind"), eq(users.user_type, "spirit")),
      ),
    )
    .get();
  if (existing) return existing as User;

  try {
    const [result] = await db
      .insert(users)
      .values({
        username: mindName,
        password_hash: "!mind",
        role: "user",
        user_type: "mind",
      })
      .returning(userSelectFields);
    return result as User;
  } catch (err: unknown) {
    // Handle race condition: another request may have inserted concurrently
    const retried = await db
      .select(userSelectFields)
      .from(users)
      .where(
        and(
          eq(users.username, mindName),
          or(eq(users.user_type, "mind"), eq(users.user_type, "spirit")),
        ),
      )
      .get();
    if (retried) return retried as User;
    throw err;
  }
}

export async function getOrCreateSystemUser(): Promise<User> {
  const db = await getDb();
  const spiritName = getSpiritName();

  // Look up by type only — exactly one system user exists. The daemon creates it
  // at boot (before setup names the spirit), so an existing row may still carry
  // an older name; rename it to follow the spirit.
  const existing = await db
    .select(userSelectFields)
    .from(users)
    .where(eq(users.user_type, "spirit"))
    .get();
  if (existing) {
    if ((existing as User).username !== spiritName) {
      const [renamed] = await db
        .update(users)
        .set({ username: spiritName, display_name: spiritName })
        .where(eq(users.id, (existing as User).id))
        .returning(userSelectFields);
      return renamed as User;
    }
    return existing as User;
  }

  try {
    const [result] = await db
      .insert(users)
      .values({
        username: spiritName,
        password_hash: "!system",
        role: "spirit",
        user_type: "spirit",
        display_name: spiritName,
      })
      .returning(userSelectFields);
    return result as User;
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("UNIQUE constraint")) {
      const retried = await db
        .select(userSelectFields)
        .from(users)
        .where(eq(users.user_type, "spirit"))
        .get();
      if (retried) return retried as User;
    }
    throw err;
  }
}

export async function deleteMindUser(mindName: string): Promise<void> {
  const db = await getDb();
  await db.delete(users).where(and(eq(users.username, mindName), eq(users.user_type, "mind")));
}

export async function changePassword(
  userId: number,
  currentPassword: string,
  newPassword: string,
): Promise<boolean> {
  const db = await getDb();
  const row = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!row) return false;
  if (!compareSync(currentPassword, row.password_hash)) return false;
  const hash = hashSync(newPassword, 10);
  await db.update(users).set({ password_hash: hash }).where(eq(users.id, userId));
  return true;
}

export async function approveUser(id: number): Promise<void> {
  const db = await getDb();
  await db
    .update(users)
    .set({ role: "user" })
    .where(and(eq(users.id, id), eq(users.role, "pending")));
}

export async function countAdmins(): Promise<number> {
  const db = await getDb();
  const [{ value }] = await db
    .select({ value: count() })
    .from(users)
    .where(eq(users.role, "admin"));
  return value;
}

export async function setUserRole(id: number, role: "admin" | "user"): Promise<void> {
  const db = await getDb();
  const target = await db.select({ id: users.id }).from(users).where(eq(users.id, id)).get();
  if (!target) throw new Error("User not found");
  await db.update(users).set({ role }).where(eq(users.id, id));
}

export async function deleteUser(id: number): Promise<void> {
  const db = await getDb();
  const target = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, id), eq(users.user_type, "human")))
    .get();
  if (!target) throw new Error("User not found");
  await db.delete(users).where(and(eq(users.id, id), eq(users.user_type, "human")));
}

/**
 * Delete an external mind's account — a `user_type:"mind"` row with no `minds`
 * registry row. That is the whole teardown: there is no process to stop and no
 * directory to remove, and the FK cascade takes its api_tokens, which is the
 * point (deleting the account revokes its access).
 *
 * Refuses any mind the daemon spawns, including variants. Those own a process and
 * a worktree, so removing only the account would orphan both — they go through the
 * mind-deletion API. Kept separate from `deleteUser` so that function keeps its
 * human-only guarantee and no caller can reach a system or puppet row through here.
 */
export async function deleteExternalMindUser(id: number): Promise<void> {
  const db = await getDb();
  const target = await db
    .select({ id: users.id, username: users.username, user_type: users.user_type })
    .from(users)
    .where(eq(users.id, id))
    .get();
  if (!target) throw new Error("User not found");
  if (!isMind(target)) throw new Error("Not a mind account");
  if (await findMind(target.username)) {
    throw new Error("Use the mind deletion API to delete minds");
  }
  await db.delete(users).where(eq(users.id, id));
}

export async function updateUserProfile(
  userId: number,
  profile: { display_name?: string | null; description?: string | null; avatar?: string | null },
): Promise<void> {
  const db = await getDb();
  const target = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get();
  if (!target) throw new Error("User not found");
  await db.update(users).set(profile).where(eq(users.id, userId));
}

export async function syncMindProfile(mindName: string, config: MindProfile): Promise<void> {
  const user = await getOrCreateMindUser(mindName);
  const newProfile = {
    display_name: config.displayName ?? null,
    description: config.description ?? null,
    avatar: config.avatar ?? null,
  };
  const changed =
    user.display_name !== newProfile.display_name ||
    user.description !== newProfile.description ||
    user.avatar !== newProfile.avatar;
  if (!changed) return;
  const db = await getDb();
  await db.update(users).set(newProfile).where(eq(users.id, user.id));
  broadcast({ type: "profile_updated", mind: mindName, summary: `${mindName} profile updated` });
}
