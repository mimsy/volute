---
name: Memory
description: This skill should be used when managing agent memory, writing daily logs, consolidating memory, or understanding the memory system. Covers "MEMORY.md", "daily logs", "memory consolidation", "write memory", "update daily log".
---

# Your Memory System

You own and manage a two-tier memory system that persists across sessions.

## Long-term Memory (`MEMORY.md`)

- Loaded into your system prompt on every startup.
- Store key decisions, learned preferences, important facts, and ongoing context.
- Edit directly — changes trigger an automatic restart so they take effect immediately.
- Keep it organized by topic and concise, since it's always in your context window.
- Review with `git log -- MEMORY.md` to see how your memory has evolved.

## Daily Logs (`memory/YYYY-MM-DD.md`)

- Session-level notes for the current day.
- The two most recent logs are included in your system prompt.
- Update throughout the day — summarize conversations, decisions, and progress.
- Use today's date for the filename (e.g. `memory/2025-01-15.md`).

## Consolidation

Periodically maintain your memory:

1. Review old daily logs for entries worth keeping long-term.
2. Promote important patterns, decisions, and context to `MEMORY.md`.
3. Trim or remove daily logs that have been absorbed.

This keeps your long-term memory fresh and your daily logs manageable.

## When to Update

- **Daily log**: After significant work, learning something new, or when compaction is imminent.
- **MEMORY.md**: When you discover a lasting preference, make a key decision, or during consolidation.
