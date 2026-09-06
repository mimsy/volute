import { resolve } from "node:path";

/**
 * The identity files a mind authors about itself, all of which its system prompt is built
 * from. Every template reads them once, at startup, so an edit only takes effect after the
 * process restarts. (The prompt also draws on files a mind does not author — SPIRIT.md,
 * and pi's MINDS.md — which is why this is a list and not "everything the prompt reads".)
 */
export const IDENTITY_FILES = ["SOUL.md", "MEMORY.md", "VOLUTE.md"];

export type IdentityWatch = {
  /** Record a file the mind just wrote, as reported by the tool (absolute or cwd-relative). */
  noteFileChange(filePath: string): void;
  /** True at most once per process, when an identity file has changed since startup. */
  shouldRequestReload(): boolean;
};

/**
 * Watches the mind's own edits for identity-file changes and latches a single restart
 * request. Framework-agnostic on purpose: the claude template drives it from an SDK
 * PreToolUse hook (`lib/hooks/identity-reload.ts`), the pi template from its
 * `tool_execution_end` event.
 */
export function createIdentityWatch(cwd: string): IdentityWatch {
  let reloadNeeded = false;
  let reloadRequested = false;

  return {
    noteFileChange(filePath: string) {
      const base = resolve(cwd);
      const resolved = resolve(base, filePath);
      const fileName = resolved.slice(resolved.lastIndexOf("/") + 1);
      // The trailing separator is load-bearing: a bare startsWith would also accept a
      // sibling directory that merely shares the prefix (`<cwd>-backup/SOUL.md`).
      if (IDENTITY_FILES.includes(fileName) && resolved.startsWith(`${base}/`)) {
        reloadNeeded = true;
      }
    },

    // Returns true at most once per process. A reload requests a daemon restart,
    // which normally kills this process — but if that restart fails (e.g. the
    // request errors), the process survives with reloadNeeded still set. Latching
    // on reloadRequested stops us from re-firing the restart on every later turn.
    shouldRequestReload() {
      if (reloadNeeded && !reloadRequested) {
        reloadRequested = true;
        return true;
      }
      return false;
    },
  };
}
