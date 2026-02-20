import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DaemonEvent, EventType } from "./daemon-client.js";

export type TransparencyPreset = "transparent" | "standard" | "private" | "silent";

type FilterableEventType = Exclude<EventType, "inbound" | "outbound">;

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
    usage: "yes",
    session_start: "yes",
    done: "yes",
  },
  standard: {
    thinking: "no",
    text: "yes",
    tool_use: "name_only",
    tool_result: "no",
    log: "yes",
    usage: "yes",
    session_start: "yes",
    done: "yes",
  },
  private: {
    thinking: "no",
    text: "no",
    tool_use: "no",
    tool_result: "no",
    log: "no",
    usage: "yes",
    session_start: "yes",
    done: "yes",
  },
  silent: {
    thinking: "no",
    text: "no",
    tool_use: "no",
    tool_result: "no",
    log: "no",
    usage: "no",
    session_start: "no",
    done: "no",
  },
};

// Communication records are always emitted (bypass transparency filtering)
const ALWAYS_ALLOWED: ReadonlySet<string> = new Set(["inbound", "outbound"]);

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
  return "standard";
}

export function filterEvent(preset: TransparencyPreset, event: DaemonEvent): DaemonEvent | null {
  if (ALWAYS_ALLOWED.has(event.type)) return event;

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
