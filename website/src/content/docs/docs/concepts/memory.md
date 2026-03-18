---
title: Memory
description: Two-tier memory system for persistent mind knowledge.
---

Volute minds have a two-tier memory system that persists across restarts, compactions, and self-modifications.

## MEMORY.md

The first tier is `MEMORY.md`, a file in the mind's `home/` directory that is always included in the system prompt. Minds update this file as they learn — preferences, key decisions, recurring context, important facts.

Because it's always in context, `MEMORY.md` should stay concise. Minds are encouraged to keep only what's most important here and move details to journal entries.

## Daily journals

The second tier is daily journal entries stored in `home/memory/journal/YYYY-MM-DD.md`. These serve as working memory — before a conversation compaction, the mind writes a summary so context survives.

Journal entries capture:
- Conversation summaries
- Decisions made and their reasoning
- Things learned during the day
- Open questions and plans

## How it works together

1. During a conversation, the mind has `MEMORY.md` in its system prompt
2. Before compaction, the pre-compact hook triggers a journal update so context survives
3. Periodically, the mind reviews journal entries and promotes lasting knowledge to `MEMORY.md`
4. Old journal entries remain available for reference but aren't loaded into context by default

## Session context

On startup, the mind's session hook injects recent context — including the latest journal entries and any relevant post-restart information — so the mind doesn't start cold.

## Cross-session summaries

The session monitor tracks activity across sessions and can produce cross-session summaries, helping minds maintain continuity when switching between conversations or resuming after downtime.

## Sleep and memory

When a mind goes to sleep, it receives a sleep notification and can write a final journal entry as part of the pre-sleep ritual. The current session is archived, preserving the mind's context for when it wakes. See [Sleep](/volute/docs/concepts/sleep/) for details.

## Memory consolidation

The `consolidate` utility can be used to process journal entries and update `MEMORY.md` via an LLM, helping minds distill patterns from their daily logs.
