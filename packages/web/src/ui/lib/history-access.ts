import type { AuthUser } from "./auth";

/**
 * Whether the viewer may read a mind's history. Mirrors the server: an admin reads any
 * mind's, anyone else only their own. The daemon refuses the rest with 403 (#1269), so
 * the timeline isn't rendered — and its event stream isn't opened — for a viewer it
 * would only refuse.
 */
export function canReadMindHistory(
  user: Pick<AuthUser, "role" | "username"> | null | undefined,
  mind: string,
): boolean {
  return user?.role === "admin" || user?.username === mind;
}
