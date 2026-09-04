export type AuthUser = {
  id: number;
  username: string;
  role: "admin" | "user" | "pending";
  user_type?: "human" | "mind";
  display_name?: string | null;
  description?: string | null;
  avatar?: string | null;
  created_at?: string;
  /**
   * Mind users only: no `minds` registry row, so nothing is spawned here — it
   * authenticates over HTTP with an API token. Server-computed; a variant is
   * local despite being absent from the mind list.
   */
  external?: boolean;
};

export type ApiToken = {
  id: number;
  label: string | null;
  createdAt: string;
};

/** The plaintext `token` exists only in this response — it is never stored. */
export type IssuedToken = ApiToken & { token: string };

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

/**
 * The current session's user, or null when there is none.
 *
 * Only 401 means "not authenticated". Any other non-ok status is a server or
 * proxy failure that says nothing about the session — returning null for it
 * would silently convert an authenticated admin into "route to login" (#724).
 */
export async function fetchMe(): Promise<AuthUser | null> {
  const res = await fetch("/api/v1/auth/me");
  if (res.status === 401) return null;
  if (!res.ok) {
    console.warn(`[auth] /auth/me failed: ${res.status}`);
    throw new Error(`Auth check failed (${res.status})`);
  }
  return res.json();
}

export function login(username: string, password: string): Promise<AuthUser> {
  return authPost("/api/v1/auth/login", { username, password });
}

export function register(username: string, password: string): Promise<AuthUser> {
  return authPost("/api/v1/auth/register", { username, password });
}

export async function logout(): Promise<void> {
  await fetch("/api/v1/auth/logout", { method: "POST" });
}

export function fetchUsers(): Promise<AuthUser[]> {
  return authGet("/api/v1/auth/users");
}

export function fetchPendingUsers(): Promise<AuthUser[]> {
  return authGet("/api/v1/auth/users/pending");
}

export function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  return authPost("/api/v1/auth/change-password", { currentPassword, newPassword });
}

export async function approveUser(id: number): Promise<void> {
  const res = await fetch(`/api/v1/auth/users/${id}/approve`, { method: "POST" });
  if (!res.ok) throw new Error("Failed to approve user");
}

export async function setUserRole(id: number, role: "admin" | "user"): Promise<void> {
  const res = await fetch(`/api/v1/auth/users/${id}/role`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || "Failed to change role");
  }
}

export async function updateUserProfile(
  id: number,
  profile: { display_name?: string | null; description?: string | null },
): Promise<void> {
  const res = await fetch(`/api/v1/auth/users/${id}/profile`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(profile),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || "Failed to update profile");
  }
}

/**
 * Register an external mind: creates a mind-typed user with no registry row and
 * mints its first token. Rejects reserved/malformed names (400) and taken ones
 * (409) — authPost surfaces the server's message for both.
 */
export function registerExternalMind(body: {
  name: string;
  displayName?: string;
  description?: string;
  tokenLabel?: string;
}): Promise<{ name: string; token: string; tokenId: number }> {
  // The response also carries the created `user`, deliberately left off this type:
  // the server builds it without the `external` flag, so typing it as AuthUser
  // would hand callers a mind that reads as local. Re-read it from the users list.
  return authPost("/api/v1/auth/minds", body);
}

export function fetchUserTokens(id: number): Promise<ApiToken[]> {
  return authGet(`/api/v1/auth/users/${id}/tokens`);
}

export function issueUserToken(id: number, label?: string): Promise<IssuedToken> {
  return authPost(`/api/v1/auth/users/${id}/tokens`, { label });
}

export async function revokeUserToken(id: number, tokenId: number): Promise<void> {
  const res = await fetch(`/api/v1/auth/users/${id}/tokens/${tokenId}`, { method: "DELETE" });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || "Failed to revoke token");
  }
}

export async function deleteUser(id: number): Promise<void> {
  const res = await fetch(`/api/v1/auth/users/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || "Failed to delete user");
  }
}

export async function updateProfile(profile: {
  display_name?: string | null;
  description?: string | null;
}): Promise<void> {
  const res = await fetch("/api/v1/auth/profile", {
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
  const res = await fetch("/api/v1/auth/avatar", { method: "POST", body: form });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || "Failed to upload avatar");
  }
  const data = (await res.json()) as { avatar: string };
  return data.avatar;
}

export async function deleteAvatar(): Promise<void> {
  const res = await fetch("/api/v1/auth/avatar", { method: "DELETE" });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || "Failed to delete avatar");
  }
}
