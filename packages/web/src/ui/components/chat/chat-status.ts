// Derives the chat status bar shown above the composer in DM chats (#574).
// Pure so it can be unit tested without rendering.

import type { Mind } from "@volute/api";

export type ChatStatusInfo = {
  kind: "stopped" | "starting" | "sleeping" | "error";
  text: string;
  /** Full failure detail, for a tooltip. Only set when kind === "error" and the
   *  viewer is privileged — the API omits `detail` for non-admin callers. */
  detail?: string;
  /** Show the Start button (stopped mind + admin viewer). */
  showStart: boolean;
};

/** Short human-facing phrases for classifier reasons (the stored detail is addressed to the mind). */
const REASON_LABELS: Record<string, string> = {
  auth_error: "the model credentials were rejected",
  rate_limit: "the model provider's rate limit was hit",
  overloaded: "the model provider was overloaded",
  network: "a network error reaching the model provider",
};

/**
 * Status line for a DM chat with `mind`, or null when the mind is healthy
 * (running with no unrecovered failure). Precedence: stopped > starting >
 * sleeping > last-turn-failed — process state is more actionable than a stale
 * failure, and a sleeping mind's notices will drain after it wakes.
 */
export function chatStatus(mind: Mind | undefined, isAdmin: boolean): ChatStatusInfo | null {
  if (!mind) return null;
  const name = mind.displayName || mind.name;

  if (mind.status === "stopped") {
    return { kind: "stopped", text: `${name} isn't running`, showStart: isAdmin };
  }
  if (mind.status === "starting") {
    return { kind: "starting", text: `${name} is waking up…`, showStart: false };
  }
  if (mind.status === "sleeping") {
    const wake = formatWakeTime(mind.wakeAt);
    const text = wake ? `${name} is asleep — waking at ${wake}` : `${name} is asleep`;
    return { kind: "sleeping", text, showStart: false };
  }
  if (mind.lastError) {
    const err = mind.lastError;
    let text: string;
    if (err.kind === "crash") {
      text = `${name}'s process crashed`;
    } else if (err.kind === "startup") {
      text = `${name} failed to start`;
    } else {
      const label = REASON_LABELS[err.reason] ?? "an unexpected error";
      text = `${name}'s last turn failed — ${label}`;
    }
    return { kind: "error", text, detail: err.detail, showStart: false };
  }
  return null;
}

/**
 * "8:00 AM" for a wake later today, "8:00 AM on Tuesday" otherwise.
 * Null for missing or unparseable times.
 */
export function formatWakeTime(wakeAt: string | null | undefined): string | null {
  if (!wakeAt) return null;
  const date = new Date(wakeAt);
  if (Number.isNaN(date.getTime())) return null;
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (date.toDateString() === new Date().toDateString()) return time;
  const day = date.toLocaleDateString("en-US", { weekday: "long" });
  return `${time} on ${day}`;
}
