import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The identity files a mind authors about itself, all of which its system prompt is built
 * from. An edit takes effect at a session boundary: claude rebuilds the prompt per SDK
 * stream, pi when a session is created or rotates, codex before every turn. (The prompt
 * also draws on files a mind does not author — SPIRIT.md, and pi's MINDS.md — which is why
 * this is a list and not "everything the prompt reads".)
 */
export const IDENTITY_FILES = ["SOUL.md", "MEMORY.md", "VOLUTE.md"];

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

type FileState = { content: string | null; mtimeMs: number; size: number };

/** The identity files as they are now — what a prompt built from them now would hold. */
export type IdentitySnapshot = Map<string, FileState>;

function fileState(path: string): FileState {
  try {
    const st = statSync(path);
    return { content: readOrNull(path), mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return { content: null, mtimeMs: -1, size: -1 };
  }
}

export function snapshotIdentityFiles(cwd: string): IdentitySnapshot {
  return new Map(IDENTITY_FILES.map((f) => [f, fileState(resolve(cwd, f))]));
}

export function sameIdentity(a: IdentitySnapshot, b: IdentitySnapshot): boolean {
  return IDENTITY_FILES.every((f) => a.get(f)?.content === b.get(f)?.content);
}

/**
 * The phrase every identity notice carries. A notice lands in the transcript, so a tail
 * carried across a boundary can hold one — the claim it makes stops being true there.
 */
export const IDENTITY_PENDING_PHRASE =
  "Your system prompt still holds the version this session started with";

/**
 * The line a mind reads, on a tool result, the first time an identity file differs from
 * what its running session's system prompt was built from. The prompt is built at a
 * session boundary, so the edit isn't live yet — and a mind that once felt it within
 * seconds deserves to be told when it will be. `staleDoc` names the mind's own mechanics
 * doc when it still says an edit restarts the mind.
 */
function identityNotice(
  changed: string[],
  sessionIdleMinutes: number,
  staleDoc: string | null,
): string {
  const boundaries = [
    ...(sessionIdleMinutes > 0
      ? [`it resumes after resting ${sessionIdleMinutes} idle minutes`]
      : []),
    "it rotates at the context limit",
    "you wake from sleep",
    "your server restarts",
  ];
  let note =
    `${changed.join(" and ")} changed on disk. ${IDENTITY_PENDING_PHRASE}; the change ` +
    `loads at this session's next boundary — when ${boundaries.join(", ")}. To load it ` +
    "sooner, `volute mind restart` restarts you right away (this turn ends there; your " +
    "session resumes).";
  if (staleDoc) {
    note +=
      ` Your ${staleDoc} still says an identity edit restarts you immediately — that ` +
      "describes an older version of your framework.";
  }
  return note;
}

/**
 * Watches for identity edits against the files a session's system prompt was built from.
 * Create it alongside that prompt, with the snapshot the prompt was built from (default:
 * the files as they are now), so a new session (or a rotated one) starts a new baseline
 * and a later edit earns the note again. `check()` runs after any tool — an edit can come
 * through a file tool or a shell — and returns the note the first time an identity file
 * differs, then null. It stats before it reads, so an unchanged file costs no read.
 */
export function createIdentityNotice(
  cwd: string,
  opts: {
    sessionIdleMinutes: number;
    /** The mind's mechanics doc (home-relative) and the line an outdated one still holds. */
    mechanicsDoc: { file: string; staleLine: string };
    baseline?: IdentitySnapshot;
  },
): { check(): string | null } {
  const baseline = opts.baseline ?? snapshotIdentityFiles(cwd);
  let noticed = false;
  return {
    check() {
      if (noticed) return null;
      const changed = IDENTITY_FILES.filter((f) => {
        const was = baseline.get(f);
        const path = resolve(cwd, f);
        let mtimeMs = -1;
        let size = -1;
        try {
          const st = statSync(path);
          mtimeMs = st.mtimeMs;
          size = st.size;
        } catch {}
        if (was && was.mtimeMs === mtimeMs && was.size === size) return false;
        return readOrNull(path) !== (was?.content ?? null);
      });
      if (changed.length === 0) return null;
      noticed = true;
      const { file, staleLine } = opts.mechanicsDoc;
      const stale = readOrNull(resolve(cwd, file))?.includes(staleLine) ?? false;
      return identityNotice(changed, opts.sessionIdleMinutes, stale ? file : null);
    },
  };
}
