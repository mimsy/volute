export function log(category: string, ...args: unknown[]) {
  const ts = new Date().toISOString();
  try {
    console.error(`[${ts}] [${category}]`, ...args);
  } catch {
    // EPIPE — parent closed pipes (detached mode). Ignore.
  }
}

// Prevent EPIPE on stderr from crashing the process (detached variant mode)
process.stderr?.on?.("error", () => {});
process.stdout?.on?.("error", () => {});
