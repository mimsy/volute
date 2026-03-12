import { daemonEmit } from "./daemon-client.js";
import { filterEvent, loadTransparencyPreset } from "./transparency.js";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
let minLevel = LEVELS.info;

// VOLUTE_DEBUG=1 overrides to debug level
if (process.env.VOLUTE_DEBUG === "1") {
  minLevel = LEVELS.debug;
}

// Loaded once at startup — mind restarts on config changes
const preset = loadTransparencyPreset();

function emit(category: string, args: unknown[]): void {
  const message = args
    .map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
  const filtered = filterEvent(preset, {
    type: "log",
    content: message,
    metadata: { category },
  });
  if (filtered) daemonEmit(filtered).catch(() => {});
}

/** Set the minimum log level. */
export function setLevel(level: LogLevel): void {
  if (!(level in LEVELS)) {
    console.error(`[logger] unknown log level "${level}", defaulting to info`);
    minLevel = LEVELS.info;
    return;
  }
  minLevel = LEVELS[level];
}

function write(level: LogLevel, category: string, ...args: unknown[]): void {
  if (LEVELS[level] < minLevel) return;
  const ts = new Date().toLocaleString();
  try {
    console.error(`[${ts}] [${level}] [${category}]`, ...args);
  } catch (err: any) {
    if (err?.code !== "EPIPE") throw err;
  }
  emit(category, args);
}

export function log(category: string, ...args: unknown[]) {
  write("info", category, ...args);
}

export function debug(category: string, ...args: unknown[]) {
  write("debug", category, ...args);
}

export function warn(category: string, ...args: unknown[]) {
  write("warn", category, ...args);
}

export function error(category: string, ...args: unknown[]) {
  write("error", category, ...args);
}

// Prevent EPIPE on stderr from crashing the process (detached variant mode)
process.stderr?.on?.("error", () => {});
process.stdout?.on?.("error", () => {});
