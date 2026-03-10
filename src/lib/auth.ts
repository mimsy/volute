import { compareSync, hashSync } from "bcryptjs";
import { and, count, eq, inArray } from "drizzle-orm";
import { getDb } from "./db.js";
import { broadcast } from "./events/activity-events.js";
import { users } from "./schema.js";
import type { MindProfile } from "./volute-config.js";

export type User = {
  id: number;
  username: string;
  role: "admin" | "user" | "pending";
  user_type: "brain" | "mind";
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

export async function createUser(username: string, password: string): Promise<User> {
  const db = await getDb();
  const hash = hashSync(password, 10);

  // First human user becomes admin automatically
  const [{ value }] = await db
    .select({ value: count() })
    .from(users)
    .where(eq(users.user_type, "brain"));
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
  if (row.user_type === "mind") return null; // minds can't log in
  if (!compareSync(password, row.password_hash)) return null;
  const { password_hash: _, ...user } = row;
  return user as User;
}

export async function getUser(id: number): Promise<User | null> {
  const db = await getDb();
  const row = await db.select(userSelectFields).from(users).where(eq(users.id, id)).get();
  return (row as User) ?? null;
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

export async function listUsersByType(userType: "brain" | "mind"): Promise<User[]> {
  const db = await getDb();
  return db
    .select(userSelectFields)
    .from(users)
    .where(eq(users.user_type, userType))
    .orderBy(users.created_at)
    .all() as Promise<User[]>;
}

export async function getOrCreateMindUser(mindName: string): Promise<User> {
  const db = await getDb();
  const existing = await db
    .select(userSelectFields)
    .from(users)
    .where(and(eq(users.username, mindName), eq(users.user_type, "mind")))
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
    if (err instanceof Error && err.message.includes("UNIQUE constraint")) {
      const retried = await db
        .select(userSelectFields)
        .from(users)
        .where(and(eq(users.username, mindName), eq(users.user_type, "mind")))
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
    .where(and(eq(users.id, id), eq(users.user_type, "brain")))
    .get();
  if (!target) throw new Error("User not found");
  await db.delete(users).where(and(eq(users.id, id), eq(users.user_type, "brain")));
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

export async function migrateMindRoles(): Promise<void> {
  const db = await getDb();
  await db
    .update(users)
    .set({ role: "user" })
    .where(and(eq(users.user_type, "mind"), inArray(users.role, ["mind", "agent"])));
}
