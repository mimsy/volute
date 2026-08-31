import { and, eq } from "drizzle-orm";
import { getDb } from "../db.js";
import { users } from "../schema.js";

export type PuppetUser = {
  id: number;
  username: string;
  display_name: string | null;
  avatar: string | null;
};

/**
 * The one true form of an external identity: `platform:identifier`.
 *
 * This is both a puppet account's username and the string recorded in the `sender`
 * columns (`mind_history.sender`, `messages.sender_name`) for anyone reaching a mind
 * from outside Volute. Those columns also hold authenticated Volute usernames, and a
 * Volute username can never contain `:` (`validateUsername` / `validateMindName`), so
 * the separator is what tells a reader — a mind reading its own history, a host reading
 * the dashboard — which kind of name they are looking at (#1016).
 *
 * Route every external sender through here rather than interpolating the colon by hand,
 * so the account and the recorded sender are provably the same string.
 */
export function externalSenderName(platform: string, identifier: string): string {
  return `${platform}:${identifier}`;
}

/**
 * Find or create a puppet user for an external platform user.
 * Username format: "platform:identifier" (e.g. "discord:alice#1234", "slack:alice")
 */
export async function findOrCreatePuppet(
  platform: string,
  platformId: string,
  displayName: string,
): Promise<PuppetUser> {
  const username = externalSenderName(platform, platformId);
  const db = await getDb();

  const existing = await db
    .select({
      id: users.id,
      username: users.username,
      display_name: users.display_name,
      avatar: users.avatar,
    })
    .from(users)
    .where(and(eq(users.username, username), eq(users.user_type, "puppet")))
    .get();

  if (existing) {
    // Update display name if it changed
    if (existing.display_name !== displayName) {
      await db.update(users).set({ display_name: displayName }).where(eq(users.id, existing.id));
      existing.display_name = displayName;
    }
    return existing;
  }

  try {
    const [result] = await db
      .insert(users)
      .values({
        username,
        password_hash: "!puppet",
        role: "user",
        user_type: "puppet",
        display_name: displayName,
      })
      .returning({
        id: users.id,
        username: users.username,
        display_name: users.display_name,
        avatar: users.avatar,
      });
    return result;
  } catch (err: unknown) {
    // Handle race condition
    if (err instanceof Error && err.message.includes("UNIQUE constraint")) {
      const retried = await db
        .select({
          id: users.id,
          username: users.username,
          display_name: users.display_name,
          avatar: users.avatar,
        })
        .from(users)
        .where(and(eq(users.username, username), eq(users.user_type, "puppet")))
        .get();
      if (retried) return retried;

      // The name is taken by a NON-puppet row, so the retry above missed and this will
      // fail identically on every future message from this person — a permanent, opaque
      // 500 on bridge inbound. New accounts can no longer take a `:` name, but one
      // registered before that guard existed still can, so name the cause (#1016).
      const conflicting = await db
        .select({ user_type: users.user_type })
        .from(users)
        .where(eq(users.username, username))
        .get();
      if (conflicting) {
        throw new Error(
          `cannot record external sender "${username}": that name is already held by a ` +
            `${conflicting.user_type} account. Rename or remove it — external identities ` +
            `own the "platform:handle" namespace.`,
        );
      }
    }
    throw err;
  }
}

/**
 * Update a puppet user's avatar URL.
 */
export async function updatePuppetAvatar(puppetId: number, avatar: string): Promise<void> {
  const db = await getDb();
  await db.update(users).set({ avatar }).where(eq(users.id, puppetId));
}
