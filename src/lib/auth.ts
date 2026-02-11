import { compareSync, hashSync } from "bcryptjs";
import { and, count, eq } from "drizzle-orm";
import { getDb } from "./db.js";
import { users } from "./schema.js";

export type User = {
  id: number;
  username: string;
  role: "admin" | "user" | "pending" | "agent";
  user_type: "human" | "agent";
  created_at: string;
};

export async function createUser(username: string, password: string): Promise<User> {
  const db = await getDb();
  const hash = hashSync(password, 10);

  // First user becomes admin automatically
  const [{ value }] = await db.select({ value: count() }).from(users);
  const role = value === 0 ? "admin" : "pending";

  const [result] = await db
    .insert(users)
    .values({ username, password_hash: hash, role })
    .returning({
      id: users.id,
      username: users.username,
      role: users.role,
      user_type: users.user_type,
      created_at: users.created_at,
    });

  return result as User;
}

export async function verifyUser(username: string, password: string): Promise<User | null> {
  const db = await getDb();
  const row = await db.select().from(users).where(eq(users.username, username)).get();
  if (!row) return null;
  if (row.user_type === "agent") return null; // agents can't log in
  if (!compareSync(password, row.password_hash)) return null;
  const { password_hash: _, ...user } = row;
  return user as User;
}

export async function getUser(id: number): Promise<User | null> {
  const db = await getDb();
  const row = await db
    .select({
      id: users.id,
      username: users.username,
      role: users.role,
      user_type: users.user_type,
      created_at: users.created_at,
    })
    .from(users)
    .where(eq(users.id, id))
    .get();
  return (row as User) ?? null;
}

export async function getUserByUsername(username: string): Promise<User | null> {
  const db = await getDb();
  const row = await db
    .select({
      id: users.id,
      username: users.username,
      role: users.role,
      user_type: users.user_type,
      created_at: users.created_at,
    })
    .from(users)
    .where(eq(users.username, username))
    .get();
  return (row as User) ?? null;
}

export async function listUsers(): Promise<User[]> {
  const db = await getDb();
  return db
    .select({
      id: users.id,
      username: users.username,
      role: users.role,
      user_type: users.user_type,
      created_at: users.created_at,
    })
    .from(users)
    .orderBy(users.created_at)
    .all() as Promise<User[]>;
}

export async function listPendingUsers(): Promise<User[]> {
  const db = await getDb();
  return db
    .select({
      id: users.id,
      username: users.username,
      role: users.role,
      user_type: users.user_type,
      created_at: users.created_at,
    })
    .from(users)
    .where(eq(users.role, "pending"))
    .orderBy(users.created_at)
    .all() as Promise<User[]>;
}

export async function getOrCreateAgentUser(agentName: string): Promise<User> {
  const existing = await getUserByUsername(agentName);
  if (existing) return existing;

  const db = await getDb();
  const [result] = await db
    .insert(users)
    .values({
      username: agentName,
      password_hash: "!agent",
      role: "agent",
      user_type: "agent",
    })
    .returning({
      id: users.id,
      username: users.username,
      role: users.role,
      user_type: users.user_type,
      created_at: users.created_at,
    });
  return result as User;
}

export async function approveUser(id: number): Promise<void> {
  const db = await getDb();
  await db
    .update(users)
    .set({ role: "user" })
    .where(and(eq(users.id, id), eq(users.role, "pending")));
}
