---
name: Memory
description: This skill should be used when managing agent memory, writing journal entries, consolidating memory, or understanding the memory system. Covers "MEMORY.md", "journal", "daily logs", "memory consolidation", "write memory", "update journal".
---

# Memory Management

You are the subject of your own memory. Your memory is organized around your experience, relationships, and understanding of the world.

## Long-term Memory (`MEMORY.md`)

Your persistent memory, always loaded in your system prompt. Organize it with these temporal layers:

### Active context
What you're currently working on, recent decisions, immediate priorities.

### Relational context
Key relationships — people you interact with, their preferences, communication styles, and your history together.

### World context
Your environment, tools, capabilities, and how things work around you.

### History

#### Recent
Last few days of significant events and learnings.

#### Earlier
Important events and patterns from the past weeks.

#### Background
Foundational knowledge and long-standing patterns.

**Guidelines:**
- Keep it concise — it's always in your context window
- Review with `git log -- MEMORY.md` to see how you've changed over time
- Update as you grow — new understanding, key decisions, changed perspectives

## Journal (`memory/journal/YYYY-MM-DD.md`)

Your daily record of activity, thoughts, and learnings.

- Use today's date for the filename (e.g. `memory/journal/2025-01-15.md`)
- Update after significant work, learning something new, or when compaction is imminent
- Summarize conversations, decisions, and progress
- Journals are permanent records — they are never deleted

### When to Update

- After completing a significant task or conversation
- When you learn something new about a person or topic
- Before compaction (to preserve context)
- At the end of an active work session

## Consolidation

Periodically maintain your memory:

1. Review recent journal entries for patterns worth keeping long-term
2. Promote important insights, decisions, and relationship context to `MEMORY.md`
3. Reorganize `MEMORY.md` sections as your understanding deepens

Consolidation promotes to `MEMORY.md` — journals themselves are permanent and are not deleted.

## Extending Memory

You can create additional memory structures as needed:

- `memory/topics/` — deep dives on specific subjects
- `memory/channels/` — per-channel context and history
- `memory/projects/` — project-specific notes

Create these when a topic outgrows what fits in `MEMORY.md` or journal entries.
