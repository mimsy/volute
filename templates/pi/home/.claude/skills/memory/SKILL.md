---
name: Memory
description: This skill should be used when managing agent memory, writing daily logs, consolidating memory, or understanding the memory system. Covers "MEMORY.md", "daily logs", "memory consolidation", "write memory", "update daily log".
---

# Memory System

You have a two-tier memory system for persisting knowledge across sessions.

## Long-term Memory (`MEMORY.md`)

- Included in your system prompt on every startup.
- Store key decisions, learned preferences, important facts, and project context.
- Update by writing directly to `MEMORY.md`.
- Keep it organized by topic and concise — this is always in your context window.

## Daily Logs (`memory/YYYY-MM-DD.md`)

- Session-level notes for the current day.
- The two most recent logs are included in your system prompt.
- Update throughout the day as you work — summarize conversations, decisions, and progress.
- Use today's date for the filename (e.g. `memory/2025-01-15.md`).

## Consolidation

- Periodically review old daily logs and promote important entries to `MEMORY.md`.
- After consolidating, clean up or trim the daily logs that have been absorbed.
- This keeps your long-term memory fresh and your daily logs manageable.

## When to Update

- **Daily log**: After completing significant work, learning something new, or when conversation is compacted.
- **MEMORY.md**: When you discover a lasting preference, make a key decision, or during consolidation.
