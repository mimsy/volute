import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { stateDir } from "../mind/registry.js";
import log from "../util/logger.js";

const plog = log.child("pending-context");

/**
 * Durable per-mind "pending context" store.
 *
 * A mind's post-lifecycle continuity message — "you were merged, here's the
 * summary/justification/memory", "you sprouted", "your upgrade landed" — is set
 * just before the mind restarts and delivered on its next start. It used to live
 * in an in-memory Map on MindManager, so a daemon crash between the merge and the
 * restart-delivery lost the message permanently (#330). Backing it with a file
 * under state/<mind>/ makes it survive a daemon restart: whatever start happens
 * next (manual, boot, crash recovery) still delivers it.
 *
 * One file per mind, keyed by the raw name (variants have their own state dir), so
 * a variant's split birth-context and its parent's merge context never collide.
 */
function pendingContextPath(name: string): string {
  return resolve(stateDir(name), "pending-context.json");
}

/** Persist the context to deliver on this mind's next start. Overwrites any prior pending context. */
export function setPendingContext(name: string, context: Record<string, unknown>): void {
  const path = pendingContextPath(name);
  try {
    mkdirSync(stateDir(name), { recursive: true });
    writeFileSync(path, `${JSON.stringify(context)}\n`);
  } catch (err) {
    plog.warn(`failed to persist pending context for ${name}`, log.errorData(err));
  }
}

/** Read the pending context for a mind, or null if none is queued (or it can't be read). */
export function readPendingContext(name: string): Record<string, unknown> | null {
  const path = pendingContextPath(name);
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf-8").trim();
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }
    plog.warn(`ignoring malformed pending context for ${name}`);
    return null;
  } catch (err) {
    plog.warn(`failed to read pending context for ${name}`, log.errorData(err));
    return null;
  }
}

/** Remove a mind's pending context. Idempotent. */
export function clearPendingContext(name: string): void {
  const path = pendingContextPath(name);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch (err) {
    plog.warn(`failed to clear pending context for ${name}`, log.errorData(err));
  }
}
