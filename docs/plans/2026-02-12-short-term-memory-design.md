# Short-Term Memory: Cross-Session Awareness

## Problem

Agents can have multiple concurrent sessions (main, discord, email, etc.) but each session is isolated — the agent has no idea what's happening in other sessions. When a user sends a message to one session, the agent should have ambient awareness of recent activity elsewhere.

## Solution

Two components:

1. **Hook** — on each incoming user prompt, automatically inject a brief summary of new activity in other sessions (if any)
2. **Skill + script** — on-demand tool for the agent to inspect another session's recent activity in detail

## Design Decisions

- **Messages over system prompt**: Injected context should create a persistent record in the conversation, not ephemeral system prompt modifications. This lets the agent reference past cross-session updates. Also avoids system prompt churn that hurts API cache hit rates.
- **Only when new activity exists**: No injection if nothing happened since last check. Avoids noise.
- **Heuristic summarization**: No LLM calls for summary generation. Avoids requiring an Anthropic API key (agent-sdk users don't need one). Smart heuristic extracts: first user message (truncated), tool use counts, message count + time span, last assistant text (truncated).
- **TypeScript throughout**: Helper script is `.ts` (run via `tsx`), no `jq` or other shell dependencies.

## Architecture

### Session JSONL Discovery

Each template stores session transcripts differently:

- **Agent-SDK (Claude Code)**: Session ID stored in `.volute/sessions/{name}.json` → JSONL at `~/.claude/projects/{encoded-cwd}/{sessionId}.jsonl`
  - CWD encoding: path with `/` replaced by `-`, leading `-` kept (e.g., `/Users/foo/home` → `-Users-foo-home`)
- **Pi**: Sessions managed by `SessionManager.continueRecent()` in `.volute/pi-sessions/{name}/`
  - JSONL files stored within session directories

### JSONL Formats

**Agent-SDK** entries (relevant types):
```jsonl
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]},"timestamp":"..."}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."},{"type":"tool_use","name":"Edit","input":{...}}]},"timestamp":"..."}
```

**Pi** entries (relevant types):
```jsonl
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"..."}]},"timestamp":"..."}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"..."},{"type":"toolCall","name":"exec","arguments":{...}}]},"timestamp":"..."}
```

### Cursor Tracking

To avoid re-reading entire JSONL files on every message, track byte offsets per session pair in `.volute/session-cursors.json`:

```json
{
  "main": {
    "discord": { "offset": 12345 },
    "email": { "offset": 5678 }
  }
}
```

Keyed by `currentSession → otherSession → byteOffset`. On each check, read only new bytes from each other session's JSONL.

### Heuristic Summarization

For new entries in each other session since last check:

1. Extract user messages (first message text, truncated to ~100 chars)
2. Count tool uses by category: file edits, file reads, commands run
3. Count total messages and compute time span
4. Extract last assistant text (truncated to ~100 chars)

Output format:
```
[Session Activity]
- discord (3m ago, 4 messages): "how do I deploy this?" -> edited 2 files, ran 3 commands
- email (20m ago, 2 messages): "new cron config request" -> updated .config/schedules.json
```

If no sessions have new activity, output nothing (no injection).

### Injection Mechanism

**Agent-SDK**: `UserPromptSubmit` SDK-level hook (TypeScript callback in `query()` options).
- Returns `{ hookSpecificOutput: { additionalContext: summary } }`
- Ephemeral (not stored as a message in JSONL), but the cross-session JSONL files themselves are the persistent record
- No extra agent turn, no latency cost

**Pi**: `before_agent_start` extension.
- Returns `{ message: { customType: "session-update", content: summary, display: true } }`
- Stored as a `CustomMessage` in the pi session JSONL
- Separate from user message, no extra turn

### Skill: On-Demand Session Inspection

A skill file at `home/.claude/skills/sessions/SKILL.md` that tells the agent:
- Where session files live and how to find them
- How to run the helper script for a detailed view
- How to interpret the output

Plus a helper script at `home/.config/scripts/session-reader.ts` that:
- Takes a session name as argument (+ optional `--lines N` for how many recent entries)
- Locates the session's JSONL file (handles both agent-sdk and pi paths)
- Parses and outputs a human-readable abbreviated log:
  - User messages (full text)
  - Assistant text (full text)
  - Tool use: name + primary argument (e.g., `[Edit home/MEMORY.md]`, `[Bash npm test]`)
  - Timestamps for each entry
  - Skips: thinking blocks, tool result content, progress entries, metadata

## New Files

```
templates/_base/src/lib/
  session-monitor.ts              # Core: JSONL discovery, parsing, cursor tracking, summarization

templates/agent-sdk/src/lib/hooks/
  session-context.ts              # UserPromptSubmit hook, calls session-monitor

templates/pi/src/lib/
  session-context-extension.ts    # before_agent_start extension, calls session-monitor

templates/_base/.init/.config/scripts/
  session-reader.ts               # Helper script for on-demand session inspection

templates/_base/.init/.claude/skills/sessions/
  SKILL.md                        # Skill: how to use session-reader and understand output
```

## Modified Files

```
templates/agent-sdk/src/agent.ts  # Add UserPromptSubmit hook to query() options
templates/pi/src/agent.ts         # Add session-context extension to extensionFactories
```

## Exports from session-monitor.ts

```typescript
// Scans other sessions for new activity and returns a formatted summary (or null)
export function getSessionUpdates(options: {
  currentSession: string;
  sessionsDir: string;
  cursorFile: string;
  jsonlResolver: (sessionName: string) => string | null;
  format: "agent-sdk" | "pi";
}): string | null;

// Reads a session's JSONL and returns a detailed human-readable log
// (used by the session-reader.ts script)
export function readSessionLog(options: {
  jsonlPath: string;
  format: "agent-sdk" | "pi";
  lines?: number;
}): string;
```

## Edge Cases

- **Session JSONL doesn't exist yet**: Skip (session created but no messages yet)
- **Session JSONL deleted/rotated**: Reset cursor offset to 0
- **Byte offset past end of file**: Reset cursor (file was truncated/recreated)
- **Very long activity**: Cap summary at ~500 chars total across all sessions to avoid bloating context
- **Current session unknown**: If the hook can't determine which session it's in, skip injection (log a warning)
- **Concurrent writes**: JSONL is append-only, so reading from a byte offset is safe even if the file is being written to concurrently
