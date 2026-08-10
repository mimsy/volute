/**
 * Parse an optional non-negative integer query param.
 *
 * Returns `undefined` when the param is absent or empty, `null` when it carries a value
 * that is not a base-10 non-negative integer (the caller should 400), and the number
 * otherwise.
 *
 * `parseInt` is deliberately not used here: it salvages a leading numeric prefix, so
 * `parseInt("2026-07-18T00:00:00Z", 10)` is `2026` — a number, not `NaN`. A
 * `Number.isNaN`/`Number.isFinite` guard therefore passes an ISO timestamp straight
 * through as a plausible-looking message id, and the endpoint serves the wrong page of
 * history with a 200 (#868). A wrong answer shaped like a right one is worse than an
 * error, so anything that is not exactly a run of digits is rejected.
 *
 * An *empty* value (`?before=`) is absence, not malformation: it carries no value to be
 * wrong about, and it is how a query string round-trips an unset field. Handling that
 * here rather than at the call sites is what keeps the three routes uniform — two of
 * them short-circuit to unpaginated history when both params are falsy, so validating
 * per-call-site would make the treatment of `?before=` depend on whether some *other*
 * param happened to be present.
 */
export function parseIntParam(raw: string | undefined): number | undefined | null {
  if (raw === undefined || raw === "") return undefined;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  // A digit run longer than 2^53 parses fine but no longer round-trips as an id.
  return Number.isSafeInteger(n) ? n : null;
}
