import { open, readFile } from "node:fs/promises";
import { findClaudeSessionFile } from "./context-breakdown.js";
import { log } from "./logger.js";
import { type ModelUsageMap, restoredTotals } from "./usage.js";

/**
 * How much of the transcript's end is read first. The SDK writes `cost-state` as a stream
 * ends, so on a cleanly ended stream the line is within the last few entries; only a
 * transcript whose last stream crashed needs the whole file.
 */
const TAIL_BYTES = 256 * 1024;

/**
 * The totals the SDK will restore when it resumes `sessionId` — see `restoredTotals`.
 * Read before the stream spawns, so nothing the new stream writes can be mistaken for
 * them. Undefined when the transcript can't be found or read: `resumedBaseline` then
 * falls back to checking the raw counters.
 */
export async function readRestoredTotals(
  cwd: string,
  sessionId: string,
): Promise<ModelUsageMap | undefined> {
  const path = findClaudeSessionFile(cwd, sessionId);
  if (!path) return undefined;
  try {
    const handle = await open(path, "r");
    let tail: string;
    let whole: boolean;
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      await handle.read(buf, 0, buf.length, start);
      tail = buf.toString("utf-8");
      whole = start === 0;
    } finally {
      await handle.close();
    }
    const fromTail = restoredTotals(tail, sessionId);
    if (whole || Object.keys(fromTail).length > 0) return fromTail;
    return restoredTotals(await readFile(path, "utf-8"), sessionId);
  } catch (err) {
    log("mind", `couldn't read restored usage totals for ${sessionId}:`, err);
    return undefined;
  }
}

/**
 * Wait for a previous stream on the same session to finish exiting, at most `timeoutMs`.
 * Its subprocess writes the final `cost-state` on the way out, and the resumed stream's
 * SDK restores from that line — so reading the transcript before it lands would baseline
 * the resumed turn on the stream before, and bill the whole of the last one again.
 * Bounded so a wedged exit can't hold the session; `resumedBaseline`'s check covers a
 * baseline that is stale anyway.
 */
export async function awaitPriorExit(
  exiting: Promise<unknown> | undefined,
  timeoutMs: number,
): Promise<void> {
  if (!exiting) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    exiting.catch(() => {}),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
}
