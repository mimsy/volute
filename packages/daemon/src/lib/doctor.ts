import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";

/**
 * Shared logic for `volute doctor` — the one command a user runs to gather
 * evidence when something breaks, since Volute keeps no telemetry.
 *
 * The redaction helpers here are the load-bearing part: the `--bundle` tarball is
 * meant to be attached to a bug report, so it MUST NOT leak secrets. Be aggressive
 * — a redacted non-secret is harmless, a leaked API key is not. These functions are
 * pure and covered by test/doctor-redaction.test.ts.
 */

/** The placeholder written in place of any redacted value. */
export const REDACTED = "[REDACTED]";

/**
 * Object keys whose value is a secret (or contains one). Matched case-insensitively
 * as a substring, so `apiKey`, `ANTHROPIC_API_KEY`, `refreshToken`, `client_secret`
 * all match. Deliberately broad — over-matching only hides a non-secret field name.
 */
const SECRET_KEY_RE =
  /(api[-_]?key|secret|token|password|passphrase|bearer|oauth|credential|private[-_]?key|client[-_]?secret|webhook|cookie|session|auth)/i;

/**
 * String values that look like a credential regardless of the key they sit under
 * (a bare token pasted into an innocuously-named field). Prefix/format based so it
 * rarely fires on ordinary config strings.
 */
const SECRET_VALUE_RE =
  /(sk-[A-Za-z0-9]|sk_[A-Za-z0-9]|vmt_|vlt_|xox[baprs]-|gh[pousr]_|github_pat_|AKIA[0-9A-Z]{12}|-----BEGIN|eyJ[A-Za-z0-9_-]{10}|Bearer\s+\S)/;

/** A long, high-entropy-looking token/hash with no spaces (base64/hex/opaque id). */
function looksLikeOpaqueToken(s: string): boolean {
  return s.length >= 40 && /^[A-Za-z0-9+/=_-]+$/.test(s);
}

export function looksLikeSecretString(s: string): boolean {
  return SECRET_VALUE_RE.test(s) || looksLikeOpaqueToken(s);
}

function maskAllValues(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) out[k] = REDACTED;
  return out;
}

/**
 * Recursively redact a parsed config value. A key matching SECRET_KEY_RE has its
 * entire subtree replaced with the placeholder; an `env`-shaped map (arbitrary
 * env-var names → values, e.g. backup.env) has every value masked; string leaves
 * that look like credentials are masked. Non-secret keys and values pass through so
 * the bundle stays useful for diagnosis.
 */
export function redactValue(value: unknown, key?: string): unknown {
  if (key !== undefined && SECRET_KEY_RE.test(key)) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => redactValue(v));
  if (value !== null && typeof value === "object") {
    // An env-var map can hold secrets under arbitrary, innocuous-looking names, so
    // mask every value rather than trusting the key names.
    if (key === "env") return maskAllValues(value as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v, k);
    return out;
  }
  if (typeof value === "string" && looksLikeSecretString(value)) return REDACTED;
  return value;
}

/**
 * Redact the text of a config.json before it goes in the bundle. On a parse failure
 * the whole file is dropped rather than passed through — a torn/corrupt config we
 * can't reason about could still contain a key.
 */
export function redactConfigJson(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "[config.json could not be parsed — omitted so no secret can leak]\n";
  }
  return `${JSON.stringify(redactValue(parsed), null, 2)}\n`;
}

/**
 * Redact an env.json (shared or per-mind). Every value is masked unconditionally —
 * env values are user-supplied and any of them may be a secret — while the keys are
 * kept so a supporter can see which variables are set.
 */
export function redactEnvJson(text: string): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "[env.json could not be parsed — omitted so no secret can leak]\n";
  }
  return `${JSON.stringify(maskAllValues(parsed), null, 2)}\n`;
}

/**
 * Scrub credential-shaped substrings out of free-form text (log tails, captured
 * command output). Logs are included verbatim for debugging, but a daemon or mind
 * can print a token in an error, so we mask three shapes: `secret-name=value`
 * pairs, `Bearer <token>`, and standalone known token prefixes. Over-masking a log
 * line is harmless; leaking a key in one is not.
 */
const LOG_SCRUBBERS: Array<[RegExp, string]> = [
  // key=value / key: value where the key names a credential — keep the key, mask the value.
  [
    /\b(api[_-]?key|secret|token|password|passwd|pwd|bearer|authorization|credential|access[_-]?key(?:[_-]?id)?|secret[_-]?access[_-]?key|refresh[_-]?token)\b(\s*[=:]\s*)"?([^\s"',}]+)/gi,
    `$1$2${REDACTED}`,
  ],
  // Authorization: Bearer <token>
  [/\bBearer\s+[A-Za-z0-9._-]+/gi, `Bearer ${REDACTED}`],
  // Standalone tokens by known prefix/shape, wherever they appear.
  [
    /\b(sk-[A-Za-z0-9-]{6,}|sk_[A-Za-z0-9-]{6,}|vmt_[A-Za-z0-9-]{6,}|vlt_[A-Za-z0-9-]{6,}|xox[baprs]-[A-Za-z0-9-]+|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]+|AKIA[0-9A-Z]{12,}|eyJ[A-Za-z0-9._-]{10,})\b/g,
    REDACTED,
  ],
];

export function redactLogText(text: string): string {
  let out = text;
  for (const [re, replacement] of LOG_SCRUBBERS) out = out.replace(re, replacement);
  return out;
}

// --- Database inspection (read-only, no migration) ---

export type MigrationInfo =
  | { ok: true; applied: number; latestMillis: number | null }
  | { ok: false; error: string };

export type BasicMind = { name: string; running: boolean; parent: string | null };

/**
 * Open the volute.db read-only and report how many migrations have been applied.
 * Unlike getDb(), this never runs migrate() — doctor only reports state, it must not
 * mutate a database it may be sharing with a live daemon.
 */
export async function readMigrationInfo(dbPath: string): Promise<MigrationInfo> {
  try {
    const db = drizzle({ connection: { url: `file:${dbPath}` } });
    const rows = (await db.all(
      sql.raw("SELECT count(*) AS n, max(created_at) AS latest FROM __drizzle_migrations"),
    )) as Array<{ n: number; latest: number | null }>;
    const row = rows[0];
    return { ok: true, applied: Number(row?.n ?? 0), latestMillis: row?.latest ?? null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Read the minds table (name, running, parent) without migrating. Empty on any failure. */
export async function readMindsBasic(dbPath: string): Promise<BasicMind[]> {
  try {
    const db = drizzle({ connection: { url: `file:${dbPath}` } });
    const rows = (await db.all(
      sql.raw("SELECT name, running, parent FROM minds ORDER BY name"),
    )) as Array<{ name: string; running: number; parent: string | null }>;
    return rows.map((r) => ({ name: r.name, running: r.running === 1, parent: r.parent }));
  } catch {
    return [];
  }
}
