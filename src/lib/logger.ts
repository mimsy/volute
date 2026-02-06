import { logBuffer } from "./log-buffer.js";

type LogLevel = "info" | "warn" | "error";

function write(level: LogLevel, msg: string, data?: Record<string, unknown>) {
  const entry = {
    level,
    msg,
    ts: new Date().toISOString(),
    ...(data ? { data } : {}),
  };
  const line = JSON.stringify(entry);
  process.stderr.write(`${line}\n`);
  logBuffer.append(entry);
}

const log = {
  info: (msg: string, data?: Record<string, unknown>) => write("info", msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => write("warn", msg, data),
  error: (msg: string, data?: Record<string, unknown>) => write("error", msg, data),
};

export default log;
