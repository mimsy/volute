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

/** Categories whose log() calls are also emitted as daemon events. */
const EMIT_CATEGORIES = new Set(["mind", "server", "auto-commit"]);

function truncate(str: string, maxLen = 200): string {
  return str.length > maxLen ? `${str.slice(0, maxLen)}...` : str;
}

/** Whether debug-level output is active (disables truncation). */
export function isDebug(): boolean {
  return minLevel <= LEVELS.debug;
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

function shouldTruncate(): boolean {
  return minLevel > LEVELS.debug;
}

function emit(category: string, args: unknown[]): void {
  if (!EMIT_CATEGORIES.has(category)) return;
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

export function logThinking(thinking: string) {
  log("thinking", shouldTruncate() ? truncate(thinking) : thinking);
}

export function logToolUse(name: string, input: unknown) {
  const inputStr = shouldTruncate()
    ? truncate(JSON.stringify(input), 100)
    : JSON.stringify(input, null, 2);
  log("tool", `${name}: ${inputStr}`);
}

export function logToolResult(name: string, output: string, isError?: boolean) {
  const prefix = isError ? "error" : "result";
  log("tool", `${name} ${prefix}: ${shouldTruncate() ? truncate(output) : output}`);
}

export function logText(text: string) {
  log("text", shouldTruncate() ? truncate(text) : text);
}

export function logMessage(direction: "in" | "out", content: string, channel?: string) {
  const arrow = direction === "in" ? "<<" : ">>";
  const channelStr = channel ? ` [${channel}]` : "";
  log("msg", `${arrow}${channelStr}`, shouldTruncate() ? truncate(content) : content);
}

// Prevent EPIPE on stderr from crashing the process (detached variant mode)
process.stderr?.on?.("error", () => {});
process.stdout?.on?.("error", () => {});
