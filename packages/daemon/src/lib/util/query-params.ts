import type { CursorResponse } from "@volute/api/pagination";
import { z } from "zod";

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

/**
 * Parse a bounded integer query param: `fallback` when absent, `null` when malformed *or
 * below `min`* (the caller should 400), clamped down to `max` otherwise.
 *
 * The shape this replaces was `parseInt(raw ?? "50", 10) || 50`, which is silent twice
 * over. `parseInt("1e9")` is `1`, so a request for a large page served exactly one row;
 * `parseInt("notanumber")` is `NaN`, so `|| 50` served the default page and called it an
 * answer. Both exit 0 with real rows on screen and nothing anywhere to say the bound was
 * never honoured — the failure leaves no artifact, which is what makes it worse than a
 * crash. The refusal is the only signal the caller ever gets.
 *
 * `max` and `min` are treated differently on purpose. `max` is the route's *documented
 * cap*: clamping to it is the published behaviour, and the CLI refuses anything past it
 * before a request is sent, so no caller reaches the clamp by accident. `min` is a floor
 * with no such story — raising `?limit=0` to `1` answers a request for nothing with one
 * plausible row, which is the very substitution this function exists to stop. So a value
 * under `min` is refused rather than lifted.
 */
export function boundedIntParam(
  raw: string | undefined,
  { fallback, min, max }: { fallback: number; min: number; max: number },
): number | null {
  const n = parseIntParam(raw);
  if (n === null) return null;
  if (n === undefined) return fallback;
  if (n < min) return null;
  return Math.min(n, max);
}

/**
 * The refusal text for a `boundedIntParam` that returned null, naming the range.
 *
 * "must be a non-negative integer" is false for the case that most often triggers it:
 * `?limit=0` *is* a non-negative integer and is refused anyway, and `?hours=200` is
 * refused by a message that never mentions 168. A caller who reads that literally retries
 * with another non-negative integer and gets the same 400 — a refusal that doesn't say
 * what would be accepted is only half a signal. Derived from the same bounds object the
 * parse used, so the two cannot drift apart.
 */
export function intParamError(name: string, { min, max }: { min: number; max: number }): string {
  if (max === Number.MAX_SAFE_INTEGER) {
    return min === 0
      ? `${name} must be a non-negative integer`
      : `${name} must be an integer of at least ${min}`;
  }
  return `${name} must be an integer between ${min} and ${max}`;
}

/**
 * A single cursor param: absent (`undefined`) or an exact run of safe-integer digits.
 * Deliberately built on `parseIntParam` rather than `z.coerce.number()` — coercion
 * salvages a leading numeric prefix and would serve the wrong page for an ISO
 * timestamp (see the `parseIntParam` note, #868).
 */
const cursorInt = z
  .string()
  .optional()
  .transform((raw, ctx) => {
    const n = parseIntParam(raw);
    if (n === null) {
      ctx.addIssue({ code: "custom", message: "must be a non-negative integer" });
      return z.NEVER;
    }
    return n;
  });

/**
 * Shared validator for cursor-paginated endpoints (`?before=&limit=`). Mount with
 * `zValidator("query", cursorParamsSchema)`; a malformed value yields a structured
 * 400, and `c.req.valid("query")` is a `CursorParams` with numeric/undefined fields.
 */
export const cursorParamsSchema = z.object({ before: cursorInt, limit: cursorInt });

/** Build the canonical cursor-paginated response envelope. */
export function cursorResponse<T>(items: T[], hasMore: boolean): CursorResponse<T> {
  return { items, hasMore };
}
