/**
 * Turn a caught fetch error into user-facing copy for a failed data load.
 *
 * The API client throws `Error(data.error || "Request failed: <status>")`, so an
 * expired/missing session surfaces as "Unauthorized"/"Forbidden" (the message
 * the daemon's auth middleware returns) or, when the server sends no body, as
 * "Request failed: 401". Both mean "log in again" — not "check your connection".
 * Any other failure keeps its own message so the real cause isn't masked.
 */
export function loadErrorMessage(err: unknown, fallback: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/\bunauthorized\b|\bforbidden\b|\b401\b|\b403\b/i.test(msg)) {
    return "Your session has expired — please log in again.";
  }
  return msg || fallback;
}
