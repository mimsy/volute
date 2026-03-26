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
 * Find or create a puppet user for an external platform user.
 * Username format: "platform:identifier" (e.g. "discord:alice#1234", "slack:alice")
 */
export async function findOrCreatePuppet(
  platform: string,
  platformId: string,
  displayName: string,
): Promise<PuppetUser> {
  const username = `${platform}:${platformId}`;
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
