import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { deliverEvent } from "../chat/system-events.js";
import { subscribe } from "../events/activity-events.js";
import { getPrompt } from "../prompts.js";
import log from "../util/logger.js";

const flog = log.child("farewell");

/**
 * The parting note lives at `<variantDir>/.mind/farewell.md`. `.mind/` is
 * mind-internal runtime state, gitignored (templates/_base/.gitignore), so the
 * note never lands in the parent's tree on merge; the join reads it directly
 * and folds the text into the merge context.
 *
 * Two path spellings for the same file, because the daemon and the mind resolve
 * relative paths from different working directories:
 *  - FAREWELL_RELPATH: from the variant project root, where the daemon reads.
 *  - FAREWELL_MIND_PATH: what the mind is told to write. The SDK runs with
 *    `cwd: home/` (templates/claude/src/server.ts), so from the mind's vantage
 *    the same file is one level up, at `../.mind/farewell.md`.
 * A contract test pins these two to the same absolute path.
 */
export const FAREWELL_RELPATH = ".mind/farewell.md";
export const FAREWELL_MIND_PATH = "../.mind/farewell.md";

/** Default bound on how long a farewell turn may run before the join proceeds. */
export const FAREWELL_TIMEOUT_MS = 120_000;

export function farewellPath(variantDir: string): string {
  return resolve(variantDir, FAREWELL_RELPATH);
}

/** Read a variant's parting note if present. Returns trimmed content or undefined. */
export function readFarewell(variantDir: string): string | undefined {
  const path = farewellPath(variantDir);
  if (!existsSync(path)) return undefined;
  try {
    const text = readFileSync(path, "utf-8").trim();
    return text || undefined;
  } catch (err) {
    flog.warn(`failed to read farewell note at ${path}`, log.errorData(err));
    return undefined;
  }
}

/**
 * Resolves when the variant finishes its farewell turn, or when the timeout
 * elapses. "Finished" is signalled by an idle event *with the note present*: a
 * variant may already have an unrelated turn in flight when we deliver, and
 * that turn's idle event must not be mistaken for the farewell turn's (which
 * would read the note before it was written and silently lose it). So an idle
 * event with no note yet is ignored and we keep waiting within the same budget.
 * The timeout is the hard backstop — if the mind writes nothing, we still
 * proceed.
 */
function waitForFarewell(
  name: string,
  variantDir: string,
  timeoutMs: number,
): { done: Promise<void>; cancel: () => void } {
  let settle!: () => void;
  const done = new Promise<void>((resolvePromise) => {
    settle = resolvePromise;
  });
  const cleanup = () => {
    clearTimeout(timeout);
    unsub();
    settle();
  };
  const timeout = setTimeout(cleanup, timeoutMs);
  const unsub = subscribe((event) => {
    if (event.mind !== name) return;
    if (event.type !== "mind_done" && event.type !== "mind_idle") return;
    if (existsSync(farewellPath(variantDir))) cleanup();
  });
  return { done, cancel: cleanup };
}

/**
 * Give a variant one final turn to wind down before it's merged and destroyed.
 * Delivers a farewell prompt, waits (bounded) for the variant to go idle, then
 * reads the parting note it may have written. Returns the note, or undefined if
 * none was written (or the variant wasn't running to take a turn).
 *
 * A hung variant must never block the join, so the wait is always bounded by
 * `timeoutMs`; on timeout we proceed and read whatever note (if any) exists.
 */
export async function runFarewellTurn(opts: {
  variantName: string;
  parentName: string;
  variantDir: string;
  running: boolean;
  timeoutMs?: number;
}): Promise<string | undefined> {
  const { variantName, parentName, variantDir, running } = opts;
  const timeoutMs = opts.timeoutMs ?? FAREWELL_TIMEOUT_MS;

  // With no live server there's no turn to take. Surface any note already on
  // disk (e.g. written before the variant was stopped), but don't run a turn.
  if (!running) return readFarewell(variantDir);

  // Clear any stale note before the live turn so that a turn which times out
  // without writing surfaces a genuine absence, not a leftover from an aborted
  // prior join.
  try {
    rmSync(farewellPath(variantDir), { force: true });
  } catch (err) {
    flog.warn(`failed to clear stale farewell note for ${variantName}`, log.errorData(err));
  }

  const message = await getPrompt("farewell_message", {
    parent: parentName,
    path: FAREWELL_MIND_PATH,
  });

  // Subscribe before delivering so a fast turn's idle event isn't missed.
  const waiter = waitForFarewell(variantName, variantDir, timeoutMs);
  const { delivered } = await deliverEvent(variantName, {
    type: "lifecycle",
    body: message,
    meta: { subtype: "farewell", parent: parentName },
  });

  // Only wait if the prompt actually reached the variant; otherwise there's nothing to
  // wait for and we shouldn't burn the full timeout.
  if (delivered) {
    await waiter.done;
  } else {
    waiter.cancel();
  }

  return readFarewell(variantDir);
}
