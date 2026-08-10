/**
 * Parse an optional non-negative integer query param.
 *
 * Returns `undefined` when the param is absent, `null` when it is present but is not a
 * base-10 non-negative integer (the caller should 400), and the number otherwise.
 *
 * `parseInt` is deliberately not used here: it salvages a leading numeric prefix, so
 * `parseInt("2026-07-18T00:00:00Z", 10)` is `2026` — a number, not `NaN`. A
 * `Number.isNaN`/`Number.isFinite` guard therefore passes an ISO timestamp straight
 * through as a plausible-looking message id, and the endpoint serves the wrong page of
 * history with a 200 (#868). A wrong answer shaped like a right one is worse than an
 * error, so anything that is not exactly a run of digits is rejected.
 */
export function parseIntParam(raw: string | undefined): number | undefined | null {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  // A digit run longer than 2^53 parses fine but no longer round-trips as an id.
  return Number.isSafeInteger(n) ? n : null;
}
