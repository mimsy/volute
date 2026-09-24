/**
 * The seam a session crosses before its first stream: a restore seed (after sleep, a
 * restart, or a missing pointer) or a cold reset (#1124). Kept apart from agent.ts so
 * its awaits — the recollection fetch above all — can be tested without the SDK.
 */

import type { RotateOutcome, SeedOutcome } from "./session-seed.js";

export type SeamOutcome =
  /** The session was torn down (shutdown or reap) while the seam was awaiting. */
  | { kind: "closed" }
  /** Nothing seeded: start fresh (restore) or resume the live session (cold reset). */
  | { kind: "none" }
  | {
      kind: "seeded";
      sessionId: string;
      cause: "restored" | "cold";
      /** Where the seam note's gap is measured from. */
      gapFrom: number | null;
      recalled: boolean;
    };

/**
 * Build the seam's seed, then — only if the session is still open — point the live
 * pointer at it (`save`). A cold reset retires the live pointer only once its seed
 * exists; if the seed can't be built (or isn't worth it) the session resumes as is.
 * `save` throwing propagates, so the caller's error handling owns it.
 */
export async function crossSeam(opts: {
  seed: "restored" | "cold";
  /** Cold reset: the live session to re-seed, and when it was last active. */
  liveSessionId?: string;
  lastActivityAt?: number;
  restore: () => Promise<SeedOutcome | null>;
  coldReset: (liveSessionId: string) => Promise<RotateOutcome | null>;
  save: (sessionId: string) => void;
  isClosed: () => boolean;
}): Promise<SeamOutcome> {
  if (opts.seed === "restored") {
    const seeded = await opts.restore();
    if (opts.isClosed()) return { kind: "closed" };
    if (!seeded) return { kind: "none" };
    opts.save(seeded.sessionId);
    return {
      kind: "seeded",
      sessionId: seeded.sessionId,
      cause: "restored",
      gapFrom: seeded.archivedAt,
      recalled: seeded.recallEntries > 0,
    };
  }
  if (!opts.liveSessionId) return { kind: "none" };
  const rotated = await opts.coldReset(opts.liveSessionId);
  if (opts.isClosed()) return { kind: "closed" };
  if (!rotated) return { kind: "none" };
  opts.save(rotated.sessionId);
  return {
    kind: "seeded",
    sessionId: rotated.sessionId,
    cause: "cold",
    gapFrom: opts.lastActivityAt ?? null,
    recalled: rotated.recallEntries > 0,
  };
}
