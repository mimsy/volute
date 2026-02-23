import { publish } from "./activity-events.js";
import log from "./logger.js";

const IDLE_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

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

/** Called when a mind event is received. Tracks active/idle transitions. */
export function onMindEvent(mind: string, type: string, channel?: string): void {
  const state = getState(mind);

  if (type === "inbound") {
    // Clear any pending idle timer — this is a new turn
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }

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
  } else if (type === "done") {
    // Start idle timer — if no new inbound within timeout, publish idle
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
    }
    state.idleTimer = setTimeout(() => {
      state.idleTimer = null;
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
    }, IDLE_TIMEOUT_MS);
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

/** Clean up all timers (e.g. on daemon shutdown). */
export function stopAll(): void {
  for (const [, state] of minds) {
    if (state.idleTimer) clearTimeout(state.idleTimer);
  }
  minds.clear();
}
