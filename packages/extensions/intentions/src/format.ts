/**
 * "held N days", except day zero — the very first thing a mind or a board
 * viewer ever sees from this feature shouldn't read as "held 0 days".
 * Used by the CLI (`volute intentions list`), the pre-prompt hook (mirrored
 * inline there — see skills/intentions/scripts/intentions-hook.sh, which
 * can't import this module since it ships standalone into the shared skill
 * pool), and the board UI.
 */
export function formatHeldDays(days: number): string {
  if (days <= 0) return "set today";
  if (days === 1) return "held 1 day";
  return `held ${days} days`;
}
