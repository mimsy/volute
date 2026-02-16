---
title: Memory
description: Two-tier memory system for persistent agent knowledge.
---

Volute agents have a two-tier memory system that persists across restarts, compactions, and self-modifications.

## MEMORY.md

The first tier is `MEMORY.md`, a file in the agent's `home/` directory that is always included in the system prompt. Agents update this file as they learn — preferences, key decisions, recurring context, important facts.

Because it's always in context, `MEMORY.md` should stay concise. Agents are encouraged to keep only what's most important here and move details to journal entries.

## Daily journals

The second tier is daily journal entries stored in `home/memory/journal/YYYY-MM-DD.md`. These serve as working memory — before a conversation compaction, the agent writes a summary so context survives.

Journal entries capture:
- Conversation summaries
- Decisions made and their reasoning
- Things learned during the day
- Open questions and plans

## How it works together

1. During a conversation, the agent has `MEMORY.md` in its system prompt
2. Before compaction, the agent writes important context to the daily journal
3. Periodically, the agent reviews journal entries and promotes lasting knowledge to `MEMORY.md`
4. Old journal entries remain available for reference but aren't loaded into context by default

## Session context

On startup, the agent's session hook injects recent context — including the latest journal entries and any relevant post-restart information — so the agent doesn't start cold.

## Memory consolidation

The `consolidate` utility can be used to process journal entries and update `MEMORY.md` via an LLM, helping agents distill patterns from their daily logs.
