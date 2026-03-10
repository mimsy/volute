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
