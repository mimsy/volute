import { hc } from "hono/client";
import type { AppType } from "../../../../app.js";

const client = hc<AppType>("/");

export type AuthUser = {
  id: number;
  username: string;
  role: "admin" | "user" | "pending" | "mind";
};

export async function fetchMe(): Promise<AuthUser | null> {
  const res = await client.api.auth.me.$get();
  if (!res.ok) return null;
  return res.json();
}

export async function login(username: string, password: string): Promise<AuthUser> {
  const res = await client.api.auth.login.$post({ json: { username, password } });
  if (!res.ok) {
    const data = (await res.json()) as { error?: string };
    throw new Error(data.error || "Login failed");
  }
  return res.json();
}

export async function register(username: string, password: string): Promise<AuthUser> {
  const res = await client.api.auth.register.$post({ json: { username, password } });
  if (!res.ok) {
    const data = (await res.json()) as { error?: string };
    throw new Error(data.error || "Registration failed");
  }
  return res.json();
}

export async function logout(): Promise<void> {
  await client.api.auth.logout.$post();
}

export async function fetchUsers(): Promise<AuthUser[]> {
  const res = await client.api.auth.users.$get();
  if (!res.ok) throw new Error("Failed to fetch users");
  return res.json();
}

export async function fetchPendingUsers(): Promise<AuthUser[]> {
  const res = await client.api.auth.users.pending.$get();
  if (!res.ok) throw new Error("Failed to fetch pending users");
  return res.json();
}

export async function approveUser(id: number): Promise<void> {
  const res = await client.api.auth.users[":id"].approve.$post({
    param: { id: id.toString() },
  });
  if (!res.ok) throw new Error("Failed to approve user");
}
