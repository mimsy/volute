import type { User } from "./auth.js";

export type CachedSession = {
  userId: number;
  user: User;
  expires: number;
};

export const sessionCache = new Map<string, CachedSession>();

export function invalidateSessionCacheForUser(userId: number): void {
  for (const [sessionId, cached] of sessionCache) {
    if (cached.userId === userId) sessionCache.delete(sessionId);
  }
}
