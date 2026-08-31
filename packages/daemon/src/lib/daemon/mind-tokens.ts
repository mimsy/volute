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
 * They exist to be evidence rather than a claim. A script has no turn in the turn
 * tracker, so the spirit's effective-principal resolution (which derives authority
 * from the turn its request arrives in) would otherwise drop every scheduled script
 * to the `basic` tier and 403 the nurture flow's `volute seed check` (#421). The
 * alternative — trusting "no session header" to mean "self-initiated" — is a claim
 * the mind's own process env can forge; a token the daemon minted for a process the
 * daemon spawned is not.
 *
 * Keyed token → run, with no reverse map: several scripts for one mind can be in
 * flight at once and each needs its own credential.
 *
 * The lifetime is the run: {@link runMindScript} revokes on the way out, and the TTL is
 * only a backstop for a run that dies without getting there. It is tempting to skip the
 * revoke so that work a script backgrounded (`… &`) keeps its credential — and that cost
 * is real, a 401 in mind-authored code with nothing tying it to the revoke. It loses to
 * the other side anyway: for the spirit this token resolves to `system` for *whoever
 * presents it*, not just the process it was minted for, so a token that outlives its run
 * is a renewable hour of admin-equivalent authority for an agent that may be sitting at
 * `basic`. A script needing to outlive its own run should re-enter through the CLI.
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
  if (entry.expiresAt <= Date.now()) {
    scriptTokens.delete(token);
    return null;
  }
  return entry.mind;
}
