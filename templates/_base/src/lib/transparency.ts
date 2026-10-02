import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DaemonEvent, EventType } from "./daemon-client.js";

export type TransparencyPreset = "transparent" | "standard" | "private" | "silent";

// Communication records, and the daemon's own bookkeeping, bypass transparency
// filtering. `error` records a turn failure, `usage` is what spend caps are counted
// from, and `done` is how the daemon learns a turn ended (turn-slot release, turn
// summaries). Transparency hides a mind's inner life from observers, never from the
// daemon — a silent mind that dropped these would hold its turn slot for half an hour
// and run uncapped (#1175).
const ALWAYS_ALLOWED = ["inbound", "outbound", "context", "error", "usage", "done"] as const;
const alwaysAllowed: ReadonlySet<string> = new Set(ALWAYS_ALLOWED);

type FilterableEventType = Exclude<EventType, (typeof ALWAYS_ALLOWED)[number]>;

const PRESET_RULES: Record<
  TransparencyPreset,
  Record<FilterableEventType, "yes" | "name_only" | "no">
> = {
  transparent: {
    thinking: "yes",
    text: "yes",
    tool_use: "yes",
    tool_result: "yes",
    log: "yes",
    session_start: "yes",
  },
  standard: {
    thinking: "no",
    text: "yes",
    tool_use: "name_only",
    tool_result: "no",
    log: "yes",
    session_start: "yes",
  },
  private: {
    thinking: "no",
    text: "no",
    tool_use: "no",
    tool_result: "no",
    log: "no",
    session_start: "yes",
  },
  silent: {
    thinking: "no",
    text: "no",
    tool_use: "no",
    tool_result: "no",
    log: "no",
    session_start: "no",
  },
};

export function loadTransparencyPreset(): TransparencyPreset {
  for (const file of ["home/.config/config.json", "home/.config/volute.json"]) {
    try {
      const config = JSON.parse(readFileSync(resolve(file), "utf-8"));
      if (config.transparency && config.transparency in PRESET_RULES) {
        return config.transparency as TransparencyPreset;
      }
    } catch {
      // try next
    }
  }
  return "transparent";
}

export function filterEvent(preset: TransparencyPreset, event: DaemonEvent): DaemonEvent | null {
  if (alwaysAllowed.has(event.type)) return event;

  const rules = PRESET_RULES[preset];
  const rule = rules[event.type as FilterableEventType];

  if (!rule) {
    // Unknown event types: pass through in transparent mode, drop otherwise
    return preset === "transparent" ? event : null;
  }
  if (rule === "no") return null;

  if (rule === "name_only" && event.type === "tool_use") {
    return { ...event, content: undefined };
  }

  return event;
}
