import { readFileSync } from "node:fs";

/**
 * Read the last `maxLines` non-empty lines of a log file.
 *
 * Used by CLI commands (`volute up`, `volute status`) to surface the actual
 * cause of a failed/crashed daemon inline instead of only printing a log path.
 *
 * A missing file (ENOENT) is benign and yields `[]`. Any other read failure
 * (e.g. EACCES on a root-owned log read by a non-root host) is itself a
 * cause worth surfacing — issue #575 is about *not* swallowing first-run
 * failures — so it's returned as a single diagnostic line rather than hidden.
 *
 * `daemon.log` is size-bounded by RotatingLog, so reading it whole is fine.
 */
export function readLogTail(logFile: string, maxLines = 20): string[] {
  let content: string;
  try {
    content = readFileSync(logFile, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    const reason = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
    return [`(could not read ${logFile}: ${reason})`];
  }
  return content
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .slice(-maxLines);
}
