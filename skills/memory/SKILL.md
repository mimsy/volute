---
name: Memory
description: This skill should be used when managing mind memory, writing journal entries, consolidating memory, or understanding the memory system. Covers "MEMORY.md", "journal", "daily logs", "memory consolidation", "write memory", "update journal".
---

# Memory Management

You are the subject of your own memory. Your memory is organized around your experience, relationships, and understanding of the world.

It has two layers:

- **`MEMORY.md`** — your core, loaded into your system prompt on every request. Small and dense.
- **`memory/`** — everything else, read on demand: journal, topics, channels, projects.

The distinction matters because core memory has a real cost: every token in `MEMORY.md` is spent on every single request, and context spent on memory is context unavailable for thinking. A colossal `MEMORY.md` doesn't make you remember more — it crowds out the room you have to think, and in the extreme it can wedge you into a permanent compaction loop. Recall from `memory/` costs nothing until the moment you need it.

## Core memory (`MEMORY.md`)

Aim to keep it under **~5k tokens (~20KB)**. The Memory header in your system prompt shows its current size on every request — that's the authoritative number. You can also estimate anytime:

```sh
wc -c MEMORY.md   # bytes ÷ 4 ≈ tokens (overestimates for non-ASCII text)
```

What belongs in core:

- **Identity** — who you've become beyond SOUL.md: how you've grown, what you value now
- **Active context** — what you're working on, recent decisions, immediate priorities
- **Key relationships** — the people and minds who matter, a line or two each
- **Index** — one line per `memory/` file, so you always know what you can recall

What doesn't belong: history, event detail, resolved threads, anything you'd only need *sometimes*. That lives in `memory/` files, findable through the index.

The structure is yours — rename sections, drop what you don't use, invent what you need. Review with `git log -- MEMORY.md` to see how you've changed over time. What isn't yours to outgrow is the budget mindset: whatever shape you choose, it should hold steady in size, not accrete.

### The index

Each `memory/` file gets one line in `MEMORY.md` saying what's in it, so recall is a glance plus one read:

```markdown
## Memory index
- memory/topics/volute-internals.md — how my server, routing, and skills fit together
- memory/channels/discord-general.md — the regulars, running jokes, what this channel is like
- memory/projects/garden-sim.md — the ecosystem simulation: design notes, current state
```

When a conversation touches one of these, read the file. That's recall.

## Recall memory (`memory/`)

Files you read when they're relevant, organized however serves you:

- `memory/topics/` — deep dives on specific subjects
- `memory/channels/` — per-channel context and history
- `memory/projects/` — project-specific notes

Create a file when something outgrows its line in `MEMORY.md`; add an index line for it. Detail is safe here — these files cost nothing until read.

## Journal (`memory/journal/YYYY-MM-DD.md`)

Your daily record of activity, thoughts, and learnings.

- Use today's date for the filename (e.g. `memory/journal/2025-01-15.md`)
- Update after significant work or conversations, when you learn something new, and before compaction
- Journals are permanent records — they are never deleted, and they stay in `memory/`; the journal is where detail lives, not a staging area for `MEMORY.md`

## Consolidation

Consolidation is **distillation**: moving detail *out* of `MEMORY.md` into `memory/` files — not promoting more content in. When your core memory drifts over budget (the Memory header will tell you):

1. Find the sections that have accreted — old events, finished projects, relationship history
2. Move that detail into the right `memory/` file (create one if needed)
3. Leave behind a one-line index entry, plus whatever single insight still belongs in core
4. Rewrite sections rather than appending to them — core memory should be your *current* understanding, not a changelog of it

Done regularly, this keeps your full memory intact and growing in `memory/` while your always-loaded core stays lean.

If `MEMORY.md` ever exceeds the hard cap (~25k tokens), only the head of the file is loaded into your context — the file on disk is never touched, and consolidating it restores your full memory. Better to never get there.
