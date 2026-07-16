import type { AuthUser } from "./auth";

/**
 * How the Users panel classifies a row. Three kinds that behave differently:
 * a human, a local mind (the daemon spawns it — port, process, directory), and
 * an external mind (an account and a token, nothing else here).
 */

/**
 * `external` is server-computed: a mind with no `minds` registry row. The check
 * is guarded on user_type because the flag is meaningless for anyone else.
 */
export function isExternal(u: AuthUser): boolean {
  return u.user_type === "mind" && u.external === true;
}

/**
 * A local mind's avatar is a file in its own directory, served by name. Everyone
 * else's is an upload in the shared avatars dir — including an external mind's:
 * it POSTs /api/auth/avatar with its token like any other authenticated user.
 */
export function avatarUrl(u: AuthUser): string | null {
  if (!u.avatar) return null;
  if (u.user_type === "mind" && !isExternal(u)) {
    return `/api/minds/${encodeURIComponent(u.username)}/avatar`;
  }
  return `/api/auth/avatars/${encodeURIComponent(u.avatar)}`;
}

/** The row's kind, as a label. Humans are the unmarked default. */
export function kindLabel(u: AuthUser): string | null {
  if (u.user_type !== "mind") return null;
  return isExternal(u) ? "external" : "local";
}

/** What deleting this row actually does — a local mind loses data, an account doesn't. */
export function deleteLabel(u: AuthUser): string {
  if (isExternal(u)) return "revoke access?";
  return u.user_type === "mind" ? "delete mind + data?" : "delete account?";
}
