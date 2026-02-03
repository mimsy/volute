# Agent Memory System

This agent project uses a two-tier memory system:

## Long-term memory: `MEMORY.md`
- Included in the agent's system prompt
- Contains key decisions, learned preferences, important context
- Managed by the agent via `write_memory` tool

## Daily logs: `memory/YYYY-MM-DD.md`
- One file per day, captures session-level context
- Updated automatically on conversation compaction
- Managed by the agent via `write_daily_log` tool
- Periodically consolidated into MEMORY.md via `consolidate_memory` tool

## Conventions
- Don't edit MEMORY.md or daily logs directly — the agent manages its own memory
- To send context to the agent for it to remember, use `molt memory --port <N> "context"`
- The agent decides what's worth keeping in long-term vs daily memory
