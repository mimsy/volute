/**
 * The decision half of session rotation, kept out of `agent.ts` so it can be driven by
 * tests without standing up the Codex SDK.
 *
 * Rotation archives the session and seeds a verbatim tail into a fresh thread. It is a
 * controlled loss of continuity, so the gate has to be sure of two things: the window
 * really is full, and rotating is still relieving it.
 */

/** Stop self-rotating after this many rotations that didn't bring context back down. */
export const MAX_CONSECUTIVE_ROTATIONS = 3;

export type RotationGuard = {
  /** Rotations since the last turn that measured under the threshold. */
  consecutive: number;
};

export function createRotationGuard(): RotationGuard {
  return { consecutive: 0 };
}

/**
 * Whether to rotate after a completed turn.
 *
 * `contextTokens` is what the model was last sent, read from the rollout — `null` when
 * that couldn't be measured. A null does **not** rotate and does **not** touch the
 * streak. Rotation is destructive, and the only other number available (the turn's input
 * delta) sums every model request in the turn, so on a tool loop it reads as several
 * times the real context; rotating on that throws away continuity the mind didn't need
 * to lose. Deferring to the SDK's native backstop at 1.5x the threshold is the cheaper
 * error. Leaving the streak alone matters too: a turn we couldn't measure is no evidence
 * either way about whether the last rotation helped.
 *
 * The streak is the right shape here *because* the measurement is the real context. A
 * turn that comes back under the threshold is proof the previous rotation worked, so the
 * streak resets and the mind may rotate again later — a mind that genuinely refills the
 * window every few turns should keep rotating, not be locked out while its context runs
 * past the model's real limit. Only rotations that relieve nothing accumulate, which is
 * the runaway this guards: a system prompt (a large MEMORY.md) that already fills most
 * of the window, which rotation cannot trim.
 *
 * Does not record the rotation: `performRotation` can fail (an unreadable rollout, a
 * thread that won't resume) and a rotation that didn't happen must not spend a slot.
 */
export function shouldRotate(
  guard: RotationGuard,
  contextTokens: number | null,
  maxContextTokens: number | undefined,
): boolean {
  if (!maxContextTokens) return false;
  if (contextTokens === null) return false;
  if (contextTokens < maxContextTokens) {
    guard.consecutive = 0; // rotation relieved the window (or it was never full)
    return false;
  }
  return guard.consecutive < MAX_CONSECUTIVE_ROTATIONS;
}

/** Record a rotation that actually happened, spending one of the streak's slots. */
export function recordRotation(guard: RotationGuard): void {
  guard.consecutive++;
}

/** True once the streak is spent — the caller logs the hand-off to the SDK backstop. */
export function budgetSpent(guard: RotationGuard): boolean {
  return guard.consecutive >= MAX_CONSECUTIVE_ROTATIONS;
}
