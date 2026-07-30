// Shared predicates over a user's `user_type` (the `users` table discriminator),
// so a guard states the question it is actually asking instead of reaching for a
// raw `user_type === "mind"` comparison — which is wrong by default and right by
// accident (it silently excludes the spirit and puppets). See issue #817.
//
// The stored `user_type` values are FROZEN this wave: renaming any of them
// (e.g. "system" → "spirit", "brain" → "human") is a separate later migration.
// Centralizing the checks here is what makes that rename a change to these
// predicate bodies plus one DB migration, not a sweep of ~30 call sites.

/**
 * Every `user_type` value written to the `users` table. This must stay in sync
 * with what the DB actually holds — a value flowing through a narrower type would
 * type-check as something it isn't (a puppet slipping through a `"human" | "mind"
 * | "system"` union is exactly the bug at issue). Empirically, four values are
 * written: humans default to `"human"`, minds (local and external) to `"mind"`,
 * bridge stand-ins to `"puppet"`, and the system spirit to `"system"`. `"brain"`
 * is NOT a live `user_type` value (the `brain_*` activity events are unrelated).
 */
export type UserType = "human" | "mind" | "puppet" | "system";

/**
 * The minimal shape the predicates read. Deliberately loose so it accepts every
 * user-ish object in the codebase:
 *
 * - Either naming convention — `user_type` (snake_case: DB rows, `AuthUser`,
 *   `AvailableUser`) or `userType` (camelCase: `Participant`).
 * - `external`, the server-computed locality flag: a `mind` user with no local
 *   `minds` registry row. Only populated on user rows that pass through
 *   `withExternalFlag`; absent (and thus treated as local) on participants and
 *   other shapes that never carry it — which matches how those call sites behaved
 *   before this refactor.
 */
export type UserTypeCarrier = {
  user_type?: UserType | string | null;
  userType?: UserType | string | null;
  external?: boolean | null;
};

function userTypeOf(u: UserTypeCarrier): string | undefined {
  return u.user_type ?? u.userType ?? undefined;
}

/**
 * Rendering / identity: does this actor get the mind icon and mind treatment?
 * Plain `mind`-typed actors do — including external minds. The spirit does NOT:
 * it is an {@link isSystemSpirit} with its own icon. Puppets render as humans.
 *
 * This is the declarative form of today's `userType === "mind"` rendering checks;
 * it deliberately does not fold in the spirit, so a site that wants the spirit
 * must say so via {@link isLocalMind} or {@link isSystemSpirit}.
 */
export function isMind(u: UserTypeCarrier): boolean {
  return userTypeOf(u) === "mind";
}

/**
 * The system spirit (the keeper) — the actor with the special coordinator
 * attributes/abilities. Currently the sole `user_type: "system"` row. Kept as its
 * own predicate so the later `"system" → "spirit"` rename is a one-line edit here.
 */
export function isSystemSpirit(u: UserTypeCarrier): boolean {
  return userTypeOf(u) === "system";
}

/**
 * "Volute manages this actor directly": it has a local mind directory / registry
 * row. True for locally-managed minds and for the spirit (which is local); false
 * for external minds, humans, and puppets. This is NOT a pure `user_type` check —
 * an external mind is `user_type: "mind"` yet not local — so it consults the
 * {@link UserTypeCarrier.external} locality flag.
 *
 * Where that flag is absent (e.g. conversation participants, which never carry
 * it), a `mind` actor is treated as local — matching the prior behavior of the
 * call sites that used `userType === "mind" || userType === "system"`.
 */
export function isLocalMind(u: UserTypeCarrier): boolean {
  const t = userTypeOf(u);
  return t === "system" || (t === "mind" && u.external !== true);
}

/**
 * The inverse locality case: a `mind` account with no local `minds` row, so
 * nothing is spawned here — it authenticates over HTTP with an API token. Only
 * meaningful once the server has stamped {@link UserTypeCarrier.external}; false
 * for everyone else, including the spirit.
 */
export function isExternal(u: UserTypeCarrier): boolean {
  return isMind(u) && u.external === true;
}
