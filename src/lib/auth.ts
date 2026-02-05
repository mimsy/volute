import { hashSync, compareSync } from "bcryptjs";
import { getDb } from "./db.js";

export type User = {
  id: number;
  username: string;
  role: "admin" | "user" | "pending";
  created_at: string;
};

type UserRow = User & { password_hash: string };

export function createUser(username: string, password: string): User {
  const db = getDb();
  const hash = hashSync(password, 10);

  // First user becomes admin automatically
  const count = db.prepare("SELECT COUNT(*) as count FROM users").get() as { count: number };
  const role = count.count === 0 ? "admin" : "pending";

  const result = db.prepare(
    "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)"
  ).run(username, hash, role);

  return {
    id: Number(result.lastInsertRowid),
    username,
    role: role as User["role"],
    created_at: new Date().toISOString(),
  };
}

export function verifyUser(username: string, password: string): User | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM users WHERE username = ?").get(username) as UserRow | undefined;
  if (!row) return null;
  if (!compareSync(password, row.password_hash)) return null;
  const { password_hash: _, ...user } = row;
  return user;
}

export function getUser(id: number): User | null {
  const db = getDb();
  const row = db.prepare("SELECT id, username, role, created_at FROM users WHERE id = ?").get(id) as User | undefined;
  return row ?? null;
}

export function getUserByUsername(username: string): User | null {
  const db = getDb();
  const row = db.prepare("SELECT id, username, role, created_at FROM users WHERE username = ?").get(username) as User | undefined;
  return row ?? null;
}

export function listUsers(): User[] {
  const db = getDb();
  return db.prepare("SELECT id, username, role, created_at FROM users ORDER BY created_at").all() as User[];
}

export function listPendingUsers(): User[] {
  const db = getDb();
  return db.prepare("SELECT id, username, role, created_at FROM users WHERE role = 'pending' ORDER BY created_at").all() as User[];
}

export function approveUser(id: number): void {
  const db = getDb();
  db.prepare("UPDATE users SET role = 'user' WHERE id = ? AND role = 'pending'").run(id);
}
