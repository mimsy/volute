import { existsSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { log } from "./logger.js";

/**
 * The pi template's equivalent of the claude session store's `committed` flag (#769):
 * a marker file inside a thread's `<sessionsDir>/<name>/` directory, present once that
 * directory is known to hold real conversation — a resumed transcript, a seeded or
 * rotated tail, or a completed turn.
 *
 * It is what decides whether starting a thread empty is a loss worth telling the mind
 * about (#985). Without it, "no transcript to resume" can't tell a thread that never
 * spoke from one whose transcript went missing — e.g. a mind moved to a new home path,
 * whose transcripts `continueRecent` no longer matches by header `cwd`.
 *
 * It lives inside the thread's directory on purpose: sleep archives the whole directory
 * (marker included), so a wake never reads the archived conversation as lost, and
 * everything that looks for transcripts filters on `.jsonl`, so the marker is never
 * mistaken for one. Sticky: cleared only where the thread genuinely starts over.
 */
const MARKER = ".committed";

export function isCommitted(dir: string): boolean {
  return existsSync(resolve(dir, MARKER));
}

export function markCommitted(dir: string): void {
  try {
    writeFileSync(resolve(dir, MARKER), "");
  } catch (err) {
    log("mind", `failed to write session marker in ${dir}:`, err);
  }
}

export function clearCommitted(dir: string): void {
  try {
    rmSync(resolve(dir, MARKER), { force: true });
  } catch (err) {
    log("mind", `failed to clear session marker in ${dir}:`, err);
  }
}

/**
 * How a notice that can be read from any thread should name the thread it is about.
 * Amnesia notices are recorded mind-level so they can't strand (#768), so "this thread"
 * would point at nothing; an ephemeral `new-*` session is named after nothing the mind
 * has seen, so naming one would be worse than not naming it.
 */
export function threadRef(name: string): string {
  return name.startsWith("new-") ? "a one-off session" : `the \`${name}\` thread`;
}
