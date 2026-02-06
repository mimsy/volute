const DEBUG = process.env.VOLUTE_DEBUG === "1";

function truncate(str: string, maxLen = 200): string {
  return str.length > maxLen ? `${str.slice(0, maxLen)}...` : str;
}

export function log(category: string, ...args: unknown[]) {
  const ts = new Date().toLocaleString();
  try {
    console.error(`[${ts}] [${category}]`, ...args);
  } catch {
    // EPIPE — parent closed pipes (detached mode). Ignore.
  }
}

export function debug(category: string, ...args: unknown[]) {
  if (!DEBUG) return;
  log(category, ...args);
}

export function logThinking(thinking: string) {
  log("thinking", DEBUG ? thinking : truncate(thinking));
}

export function logToolUse(name: string, input: unknown) {
  const inputStr = DEBUG ? JSON.stringify(input, null, 2) : truncate(JSON.stringify(input), 100);
  log("tool", `${name}: ${inputStr}`);
}

export function logToolResult(name: string, output: string, isError?: boolean) {
  const prefix = isError ? "error" : "result";
  log("tool", `${name} ${prefix}: ${DEBUG ? output : truncate(output)}`);
}

export function logText(text: string) {
  log("text", DEBUG ? text : truncate(text));
}

export function logMessage(direction: "in" | "out", content: string, channel?: string) {
  const arrow = direction === "in" ? "<<" : ">>";
  const channelStr = channel ? ` [${channel}]` : "";
  log("msg", `${arrow}${channelStr}`, DEBUG ? content : truncate(content));
}

// Prevent EPIPE on stderr from crashing the process (detached variant mode)
process.stderr?.on?.("error", () => {});
process.stdout?.on?.("error", () => {});
