const DEBUG = process.env.VOLUTE_DEBUG === "1";

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
  if (DEBUG) {
    log("thinking", thinking);
  } else {
    // Show first 200 chars in normal mode
    log("thinking", thinking.slice(0, 200) + (thinking.length > 200 ? "..." : ""));
  }
}

export function logToolUse(name: string, input: unknown) {
  if (DEBUG) {
    log("tool", `${name}:`, JSON.stringify(input, null, 2));
  } else {
    // Compact view in normal mode
    const inputStr = JSON.stringify(input);
    const preview = inputStr.length > 100 ? inputStr.slice(0, 100) + "..." : inputStr;
    log("tool", `${name}: ${preview}`);
  }
}

export function logToolResult(name: string, output: string, isError?: boolean) {
  const prefix = isError ? "error" : "result";
  if (DEBUG) {
    log("tool", `${name} ${prefix}:`, output);
  } else {
    const preview = output.length > 200 ? output.slice(0, 200) + "..." : output;
    log("tool", `${name} ${prefix}: ${preview}`);
  }
}

export function logText(text: string) {
  if (DEBUG) {
    log("text", text);
  } else {
    const preview = text.length > 200 ? text.slice(0, 200) + "..." : text;
    log("text", preview);
  }
}

export function logMessage(direction: "in" | "out", content: string, channel?: string) {
  const arrow = direction === "in" ? "<<" : ">>";
  const channelStr = channel ? ` [${channel}]` : "";
  if (DEBUG) {
    log("msg", `${arrow}${channelStr}`, content);
  } else {
    const preview = content.length > 200 ? content.slice(0, 200) + "..." : content;
    log("msg", `${arrow}${channelStr}`, preview);
  }
}

// Prevent EPIPE on stderr from crashing the process (detached variant mode)
process.stderr?.on?.("error", () => {});
process.stdout?.on?.("error", () => {});
