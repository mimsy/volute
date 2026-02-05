export type AuthUser = {
  id: number;
  username: string;
  role: "admin" | "user" | "pending";
};

export async function fetchMe(): Promise<AuthUser | null> {
  const res = await fetch("/api/auth/me");
  if (!res.ok) return null;
  return res.json();
}

export async function login(username: string, password: string): Promise<AuthUser> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Login failed");
  }
  return res.json();
}

export async function register(username: string, password: string): Promise<AuthUser> {
  const res = await fetch("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Registration failed");
  }
  return res.json();
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST" });
}

export async function fetchUsers(): Promise<AuthUser[]> {
  const res = await fetch("/api/auth/users");
  if (!res.ok) throw new Error("Failed to fetch users");
  return res.json();
}

export async function fetchPendingUsers(): Promise<AuthUser[]> {
  const res = await fetch("/api/auth/users/pending");
  if (!res.ok) throw new Error("Failed to fetch pending users");
  return res.json();
}

export async function approveUser(id: number): Promise<void> {
  const res = await fetch(`/api/auth/users/${id}/approve`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to approve user");
}
