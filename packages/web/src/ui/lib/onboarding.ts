import type { Mind } from "@volute/api";

/**
 * True when the system has no regular minds yet — the fresh-install state
 * where onboarding guidance should be shown. The spirit doesn't count as a
 * regular mind.
 *
 * `mindsLoaded` guards the initial page load: `minds` is an empty array
 * while the first fetch is in flight, which must not flash the onboarding
 * state on systems that do have minds.
 */
export function showMindOnboarding(minds: Mind[], mindsLoaded: boolean): boolean {
  return mindsLoaded && minds.every((m) => m.mindType === "spirit");
}

/** The spirit mind, if present. */
export function findSpirit(minds: Mind[]): Mind | undefined {
  return minds.find((m) => m.mindType === "spirit");
}
