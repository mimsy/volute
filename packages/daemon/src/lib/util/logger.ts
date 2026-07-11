import { logBuffer } from "./log-buffer.js";

type LogLevel = "debug" | "info" | "warn" | "error";
type LogFn = (msg: string, data?: Record<string, unknown>) => void;
type ChildLogger = { debug: LogFn; info: LogFn; warn: LogFn; error: LogFn };

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
let minLevel = LEVELS[(process.env.VOLUTE_LOG_LEVEL as LogLevel) || "info"] ?? LEVELS.info;
let output: (line: string) => void = (line) => process.stderr.write(`${line}\n`);

function write(level: LogLevel, cat: string, msg: string, data?: Record<string, unknown>): void {
  if (LEVELS[level] < minLevel) return;
  const entry = {
    level,
    cat,
    msg,
    ts: new Date().toISOString(),
    ...(data ? { data } : {}),
  };
  output(JSON.stringify(entry));
  logBuffer.append(entry);
}

function child(cat: string): ChildLogger {
  return {
    debug: (msg, data) => write("debug", cat, msg, data),
    info: (msg, data) => write("info", cat, msg, data),
    warn: (msg, data) => write("warn", cat, msg, data),
    error: (msg, data) => write("error", cat, msg, data),
  };
}

/** Extract error info preserving stack traces for structured logging. */
function errorData(err: unknown): Record<string, unknown> {
  if (err instanceof Error) return { error: err.stack ?? err.message };
  // WHATWG ErrorEvent-shaped objects (e.g. WebSocket `onerror`) are not Error
  // instances; unwrap their `.error`/`.message` so we don't log "[object ErrorEvent]".
  if (err && typeof err === "object") {
    const e = err as { error?: unknown; message?: unknown };
    if (e.error instanceof Error) return { error: e.error.stack ?? e.error.message };
    if (typeof e.error === "string" && e.error) return { error: e.error };
    if (typeof e.message === "string" && e.message) return { error: e.message };
  }
  return { error: String(err) };
}

const log = {
  ...child("system"),
  child,
  errorData,
  setLevel(level: LogLevel) {
    minLevel = LEVELS[level];
  },
  setOutput(fn: (line: string) => void) {
    output = fn;
  },
};

export default log;
