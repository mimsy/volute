import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "./db.js";
import { apiTokens } from "./schema.js";

/**
 * Durable per-user API tokens.
 *
 * Orthogonal to the in-memory native-mind token map
 * (`daemon/mind-tokens.ts`): these are DB-backed, so they survive a daemon
 * restart, and they resolve to a `users` row rather than a mind name.
 *
 * The `vmt_` prefix lets the auth path skip the DB entirely for non-prefixed
 * Bearers (native mind tokens and session ids are bare UUIDs) and makes
 * log-grep audits feasible.
 */
export const API_TOKEN_PREFIX = "vmt_";

/** Mint a new plaintext token: prefix + 256 bits of entropy. */
function generateToken(): string {
  return API_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/**
 * SHA-256 is correct here: the secret is 256-bit random, so there is no
 * dictionary/brute-force risk that a slow KDF would defend against, and the
 * hash must support an indexed equality lookup on the auth path. Do NOT swap
 * this for bcrypt/argon, and do not reduce the token entropy.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type ApiTokenInfo = {
  id: number;
  label: string | null;
  created_at: string;
};

/**
 * Issue a token for a user. The returned plaintext is the only moment it
 * exists outside the caller — it is never stored, logged, or re-derivable.
 */
export async function issueApiToken(
  userId: number,
  label?: string,
): Promise<{ id: number; token: string; label: string | null; created_at: string }> {
  const db = await getDb();
  const token = generateToken();
  const [row] = await db
    .insert(apiTokens)
    .values({ user_id: userId, token_hash: hashToken(token), label: label ?? null })
    .returning({ id: apiTokens.id, label: apiTokens.label, created_at: apiTokens.created_at });
  return { id: row.id, token, label: row.label, created_at: row.created_at };
}

/**
 * Resolve a Bearer value to a user id, or null. Non-prefixed values return
 * immediately without touching the DB.
 */
export async function resolveApiToken(token: string): Promise<number | null> {
  if (!token.startsWith(API_TOKEN_PREFIX)) return null;
  const db = await getDb();
  const row = await db
    .select({ user_id: apiTokens.user_id })
    .from(apiTokens)
    .where(eq(apiTokens.token_hash, hashToken(token)))
    .get();
  return row?.user_id ?? null;
}

/**
 * Revoke by deleting the row — a revoked token can never resolve again.
 * Scoped to `userId` in the DELETE itself, so a token id belonging to another
 * user cannot be deleted through a path that claims to be this user's.
 * Returns false when the token doesn't exist or isn't this user's.
 */
export async function revokeApiToken(userId: number, id: number): Promise<boolean> {
  const db = await getDb();
  const rows = await db
    .delete(apiTokens)
    .where(and(eq(apiTokens.id, id), eq(apiTokens.user_id, userId)))
    .returning({ id: apiTokens.id });
  return rows.length > 0;
}

/** List a user's tokens. Never returns the hash, never returns a token. */
export async function listApiTokens(userId: number): Promise<ApiTokenInfo[]> {
  const db = await getDb();
  return (
    db
      .select({ id: apiTokens.id, label: apiTokens.label, created_at: apiTokens.created_at })
      .from(apiTokens)
      .where(eq(apiTokens.user_id, userId))
      // By id, not created_at: datetime('now') has second granularity, so two
      // tokens issued in the same second would order arbitrarily.
      .orderBy(apiTokens.id)
      .all()
  );
}
