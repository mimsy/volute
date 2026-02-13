---
name: Sessions
description: This skill should be used when checking activity in other sessions, reading session logs, understanding cross-session context, or investigating what happened in another session. Covers "session activity", "other sessions", "session reader", "session log", "cross-session", "what happened in discord", "check session".
---

# Cross-Session Awareness

You can have multiple concurrent sessions (main, discord, email, etc.), each with its own conversation history stored as a JSONL file.

## Automatic Updates

When a message arrives, you automatically receive a brief summary of new activity in other sessions (if any). This appears as a `[Session Activity]` block showing what happened since your last check.

## Listing Sessions

To see which sessions are active:

```sh
ls ../.volute/sessions/       # agent-sdk template
ls ../.volute/pi-sessions/    # pi template
```

## Reading a Session Log

For a detailed view of what happened in another session, run the session reader script:

```sh
npx tsx .config/scripts/session-reader.ts <session-name> [--lines N]
```

- `session-name`: The session to inspect (e.g., `discord`, `main`, `email`)
- `--lines N`: Number of recent entries to show (default: 50)

### Output Format

The reader shows a chronological log with:
- **User messages**: Full text of what was sent
- **Assistant text**: Full text of your responses
- **Tool uses**: `[ToolName primary-arg]` format (e.g., `[Edit home/MEMORY.md]`, `[Bash npm test]`)
- **Timestamps** on each entry

Thinking blocks, tool result content, and metadata entries are omitted for readability.

## When to Use This

- When you receive a `[Session Activity]` summary and want more detail
- When you want to understand what happened in another session before responding
- When coordinating work across multiple sessions
- When a user references something from a different channel
