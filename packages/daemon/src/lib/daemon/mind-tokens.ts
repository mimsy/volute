import { randomUUID } from "node:crypto";

// In-memory bidirectional map: token ↔ mindName
const tokenToMind = new Map<string, string>();
const mindToToken = new Map<string, string>();

export function generateMindToken(mindName: string): string {
  // Revoke any existing token first
  revokeMindToken(mindName);
  const token = randomUUID();
  tokenToMind.set(token, mindName);
  mindToToken.set(mindName, token);
  return token;
}

export function revokeMindToken(mindName: string): void {
  const token = mindToToken.get(mindName);
  if (token) {
    tokenToMind.delete(token);
    mindToToken.delete(mindName);
  }
}

export function resolveMindToken(token: string): string | null {
  return tokenToMind.get(token) ?? null;
}

export function getMindToken(mindName: string): string | null {
  return mindToToken.get(mindName) ?? null;
}

/**
 * Tokens for mind-authored scripts the *daemon* spawns (scheduled scripts, the
 * pre-sleep hook) — issued per run and revoked when it ends.
 *
 * Previously such a script was handed the mind's own long-lived token, which lives
 * until the mind restarts. That is a credential with no relationship to the work it
 * was issued for: it stays valid long after the script exits, and every script run
 * hands out the same one, so a single mind-authored script that logs its environment
 * leaks a credential good for the rest of the mind's uptime. Scoping it to the run
 * bounds that to seconds.
 *
 * Keyed token → run, with no reverse map: several scripts for one mind can be in
 * flight at once and each needs its own revocable credential.
 *
 * The TTL is a backstop for a run that dies without reaching its `finally`, and it
 * *slides*: every successful resolve pushes the expiry out again. A fixed hour would
 * have been a cliff rather than a bound — `Scheduler.runScript` passes no timeout, so a
 * backup or export legitimately running past the hour would start 401ing at minute 61
 * having worked for sixty, a silent partial failure the old long-lived token never had.
 * Sliding it means a script stays authenticated for as long as it is actually working,
 * while an abandoned token still expires an hour after its last use.
 *
 * The cost, stated because it is real: work a script backgrounds (`… &`), or work left
 * behind when a `timeout` reaps only the immediate child, loses its credential when the
 * run ends. A script needing to outlive its own run should re-enter through the CLI.
 */
const SCRIPT_TOKEN_TTL = 60 * 60 * 1000;
const scriptTokens = new Map<string, { mind: string; expiresAt: number }>();

export function issueScriptToken(mindName: string): string {
  const now = Date.now();
  for (const [t, entry] of scriptTokens) {
    if (entry.expiresAt <= now) scriptTokens.delete(t);
  }
  const token = randomUUID();
  scriptTokens.set(token, { mind: mindName, expiresAt: now + SCRIPT_TOKEN_TTL });
  return token;
}

export function revokeScriptToken(token: string): void {
  scriptTokens.delete(token);
}

export function resolveScriptToken(token: string): string | null {
  const entry = scriptTokens.get(token);
  if (!entry) return null;
  const now = Date.now();
  if (entry.expiresAt <= now) {
    scriptTokens.delete(token);
    return null;
  }
  // Slide the window: a script that is still working keeps its credential.
  entry.expiresAt = now + SCRIPT_TOKEN_TTL;
  return entry.mind;
}

/** Test seam: a script token's current expiry, for asserting the sliding window. */
export function scriptTokenExpiryForTest(token: string): number | undefined {
  return scriptTokens.get(token)?.expiresAt;
}
