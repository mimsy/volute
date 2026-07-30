import { isExternal, isMind } from "@volute/api/user-type";
import type { AuthUser } from "./auth";

// The shared classification (isMind/isExternal/isSystemSpirit/isLocalMind) lives in
// @volute/api/user-type. This module keeps only the Users-panel *presentation*
// helpers — avatar URL, kind label, delete copy — built on those predicates.

export { isExternal };

/**
 * A local mind's avatar is a file in its own directory, served by name. Everyone
 * else's is an upload in the shared avatars dir — including an external mind's:
 * it POSTs /api/auth/avatar with its token like any other authenticated user. The
 * spirit (`user_type: "spirit"`, not a `mind`) also falls to the shared dir here.
 */
export function avatarUrl(u: AuthUser): string | null {
  if (!u.avatar) return null;
  if (isMind(u) && !isExternal(u)) {
    return `/api/minds/${encodeURIComponent(u.username)}/avatar`;
  }
  return `/api/auth/avatars/${encodeURIComponent(u.avatar)}`;
}

/** The row's kind, as a label. Humans are the unmarked default. */
export function kindLabel(u: AuthUser): string | null {
  if (!isMind(u)) return null;
  return isExternal(u) ? "external" : "local";
}

/** What deleting this row actually does — a local mind loses data, an account doesn't. */
export function deleteLabel(u: AuthUser): string {
  if (isExternal(u)) return "revoke access?";
  return isMind(u) ? "delete mind + data?" : "delete account?";
}
