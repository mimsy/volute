import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { createIdentityNotice } from "../identity-watch.js";

/** What older mechanics docs said before identity edits stopped restarting the mind. */
const STALE_DOC_LINE = "Editing any identity file triggers an automatic restart";

/**
 * PostToolUse hook (any tool — an edit can come through Edit, Write, or Bash) that tells
 * the mind, once per SDK stream, that an identity file has changed since this stream's
 * system prompt was built. Create it alongside that prompt: its baseline is read at
 * creation, and a new stream starts a new baseline, so a later edit earns the note again.
 */
export function createIdentityNoticeHook(cwd: string, sessionIdleMinutes: number): HookCallback {
  const notice = createIdentityNotice(cwd, {
    sessionIdleMinutes,
    mechanicsDoc: { file: "CLAUDE.md", staleLine: STALE_DOC_LINE },
  });
  return async () => {
    const additionalContext = notice.check();
    if (!additionalContext) return {};
    return {
      hookSpecificOutput: { hookEventName: "PostToolUse" as const, additionalContext },
    };
  };
}
