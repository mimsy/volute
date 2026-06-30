import log from "../util/logger.js";
import { publish } from "./activity-events.js";

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

type MindState = {
  active: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  channel?: string;
};

const minds = new Map<string, MindState>();

function getState(mind: string): MindState {
  let state = minds.get(mind);
  if (!state) {
    state = { active: false, idleTimer: null };
    minds.set(mind, state);
  }
  return state;
}

// Events that do not open or advance a turn, so they never mark a mind active.
// `session_start` fires once when the persistent SDK stream opens (at boot and
// again after each compaction/resume), not when a turn runs — treating it as
// active wedged idle-booted minds "active" forever. `usage`/`log` are metadata.
// (`done` is handled explicitly before this check.)
const IGNORED_EVENTS = new Set(["session_start", "usage", "log"]);

/**
 * Arm (or refresh) the inactivity watchdog. "Active" means an open turn, so it
 * is cleared by the turn's `done`. This watchdog is the safety net for a turn
 * that opens (a delivery, or the mind's own processing events) but never emits
 * a matching `done` — e.g. the SDK hangs mid-turn, or the `done` emit is lost.
 * Every real event refreshes the timer, so a mind that emits events at least
 * every IDLE_TIMEOUT_MS stays active while working; a mind silent longer than
 * that (e.g. one long tool call) trips the watchdog and re-emits mind_active on
 * its next event.
 */
function armIdleTimer(mind: string, state: MindState): void {
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
  }
  state.idleTimer = setTimeout(() => {
    state.idleTimer = null;
    // The timer only fires when no event refreshed it during the window, so the
    // mind is genuinely idle. Clear active (heals a wedged session that never
    // emitted `done`) and publish the idle transition for the timeline/cleanup.
    state.active = false;
    publish({
      type: "mind_idle",
      mind,
      summary: `${mind} is idle`,
    }).catch((err) => {
      log.error("[mind-activity] failed to publish mind_idle", log.errorData(err));
    });
  }, IDLE_TIMEOUT_MS);
}

/** Called when a mind event is received. Tracks active/idle transitions. */
export function onMindEvent(mind: string, type: string, channel?: string): void {
  const state = getState(mind);
  if (type === "done") {
    // Mark inactive immediately so the next turn re-emits mind_active.
    // The frontend clears the active dot on mind_done; without this reset,
    // subsequent turns within the idle window would skip re-emitting.
    state.active = false;
    // Arm idle timer — publishes mind_idle later if no new activity (cleanup).
    armIdleTimer(mind, state);
  } else if (!IGNORED_EVENTS.has(type)) {
    // A turn is open: a delivery, or the mind's own processing events (text,
    // tool_use, thinking, ...). Refresh the inactivity watchdog so the mind
    // stays active while working but self-heals to idle if no `done` arrives.
    armIdleTimer(mind, state);

    if (!state.active) {
      state.active = true;
      state.channel = channel;
      publish({
        type: "mind_active",
        mind,
        summary: `${mind} is active`,
        metadata: channel ? { channel } : undefined,
      }).catch((err) => {
        log.error("[mind-activity] failed to publish mind_active", log.errorData(err));
      });
    }
  }
}

/** Mark a mind as immediately idle (e.g. on stop/crash). */
export function markIdle(mind: string): void {
  const state = minds.get(mind);
  if (!state) return;
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
  if (state.active) {
    state.active = false;
    publish({
      type: "mind_idle",
      mind,
      summary: `${mind} is idle`,
    }).catch((err) => {
      log.error("[mind-activity] failed to publish mind_idle", log.errorData(err));
    });
  }
  minds.delete(mind);
}

/** Return the set of currently active mind names. */
export function getActiveMinds(): string[] {
  const result: string[] = [];
  for (const [mind, state] of minds) {
    if (state.active) result.push(mind);
  }
  return result;
}

/** Clean up all timers (e.g. on daemon shutdown). */
export function stopAll(): void {
  for (const [, state] of minds) {
    if (state.idleTimer) clearTimeout(state.idleTimer);
  }
  minds.clear();
}
