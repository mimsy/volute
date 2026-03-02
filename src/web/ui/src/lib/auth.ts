export type AuthUser = {
  id: number;
  username: string;
  role: "admin" | "user" | "pending" | "mind";
  display_name?: string | null;
  description?: string | null;
  avatar?: string | null;
};

async function authGet<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

async function authPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export async function fetchMe(): Promise<AuthUser | null> {
  const res = await fetch("/api/auth/me");
  if (!res.ok) return null;
  return res.json();
}

export function login(username: string, password: string): Promise<AuthUser> {
  return authPost("/api/auth/login", { username, password });
}

export function register(username: string, password: string): Promise<AuthUser> {
  return authPost("/api/auth/register", { username, password });
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST" });
}

export function fetchUsers(): Promise<AuthUser[]> {
  return authGet("/api/auth/users");
}

export function fetchPendingUsers(): Promise<AuthUser[]> {
  return authGet("/api/auth/users/pending");
}

export function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  return authPost("/api/auth/change-password", { currentPassword, newPassword });
}

export async function approveUser(id: number): Promise<void> {
  const res = await fetch(`/api/auth/users/${id}/approve`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to approve user");
}

export async function updateProfile(profile: {
  display_name?: string | null;
  description?: string | null;
}): Promise<void> {
  const res = await fetch("/api/auth/profile", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(profile),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || "Failed to update profile");
  }
}

export async function uploadAvatar(file: File): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/auth/avatar", { method: "POST", body: form });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || "Failed to upload avatar");
  }
  const data = (await res.json()) as { avatar: string };
  return data.avatar;
}

export async function deleteAvatar(): Promise<void> {
  const res = await fetch("/api/auth/avatar", { method: "DELETE" });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || "Failed to delete avatar");
  }
}
