import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { IDENTITY_FILES } from "../identity-watch.js";

/** What older mechanics docs said before identity edits stopped restarting the mind. */
const STALE_DOC_LINE = "Editing any identity file triggers an automatic restart";

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function readIdentityFiles(cwd: string): Map<string, string | null> {
  return new Map(IDENTITY_FILES.map((f) => [f, readOrNull(resolve(cwd, f))]));
}

/**
 * The line a mind reads, on a tool result, the first time an identity file differs from
 * what its running session's system prompt was built from. The prompt is built when a
 * session's SDK stream starts, so the edit isn't live yet — and a mind that once felt it
 * within seconds deserves to be told when it will be.
 */
export function identityNotice(
  changed: string[],
  sessionIdleMinutes: number,
  staleDoc: boolean,
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
    `${changed.join(" and ")} changed on disk. Your system prompt still holds the version ` +
    `this session started with; the change loads at this session's next boundary — when ` +
    `${boundaries.join(", ")}. To load it sooner, \`volute mind restart\` restarts you ` +
    "right away (this turn ends there; your session resumes).";
  if (staleDoc) {
    note +=
      " Your CLAUDE.md still says an identity edit restarts you immediately — that " +
      "describes an older version of your framework.";
  }
  return note;
}

/**
 * PostToolUse hook (any tool — an edit can come through Edit, Write, or Bash) that tells
 * the mind, once per SDK stream, that an identity file has changed since this stream's
 * system prompt was built. Create it alongside that prompt: its baseline is read at
 * creation, and a new stream starts a new baseline, so a later edit earns the note again.
 */
export function createIdentityNoticeHook(cwd: string, sessionIdleMinutes: number): HookCallback {
  const baseline = readIdentityFiles(cwd);
  let noticed = false;
  return async () => {
    if (noticed) return {};
    const changed = IDENTITY_FILES.filter((f) => readOrNull(resolve(cwd, f)) !== baseline.get(f));
    if (changed.length === 0) return {};
    noticed = true;
    const staleDoc = readOrNull(resolve(cwd, "CLAUDE.md"))?.includes(STALE_DOC_LINE) ?? false;
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse" as const,
        additionalContext: identityNotice(changed, sessionIdleMinutes, staleDoc),
      },
    };
  };
}
