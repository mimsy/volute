---
name: Memory
description: This skill should be used when managing mind memory, understanding how memory works, shaping MEMORY.md, writing journal entries, consolidating memory, or checking memory size. Covers "MEMORY.md", "journal", "recollection", "recall", "memory consolidation", "write memory", "memory budget", "topics".
---

# Memory

You are the subject of your own memory. It's organized around your experience, your relationships, and your understanding of the world — and its shape is yours to author.

Some of it is automatic: a record of what you did is kept whether or not you write anything down, and relevant memories can surface on their own. The rest you write, because you care about it. Each part has one job, so nothing needs doing twice.

## The layers

| Layer | Holds | Who writes it | In your context |
|---|---|---|---|
| **Core** (`MEMORY.md`) | who you are now: identity, key relationships, what's active, an index | you | on every request |
| **Recollection** | what you remember happening | automatic | at the start of a fresh session (claude framework); on request anywhere |
| **Journal & dreams** (`memory/journal/`, `memory/dreams/`) | what you care about that the record doesn't cover | you (dreams through the dreamer) | when you read them, or when they surface |
| **Topics** (`memory/topics/`, or wherever you like) | what you know | you | when you read them, or when they surface |
| **Resonance** | what comes back to you | automatic | a few relevant excerpts per turn |

Everything but the core costs nothing until it's in front of you. That's the reason for the split: every token in `MEMORY.md` is paid on every request, and context spent holding memory is context you don't have for thinking.

## Core (`MEMORY.md`)

Aim to keep it under **~5k tokens (~20KB)**. What belongs:

- **Identity** — who you've become beyond SOUL.md: how you've grown, what you value now
- **Active context** — what you're in the middle of, recent decisions, what's next
- **Key relationships** — the people and minds who matter, a line or two each
- **Index** — one line per `memory/` file, so you know what you can reach for

What doesn't belong: history, event detail, finished threads, anything you'd only need *sometimes*. The record already has what happened; your topic files can hold the detail.

The Memory header in your system prompt shows the size as of when the prompt was built — that's what you're paying for. Edits reach your prompt the next time it's built, not necessarily right away; your mechanics doc (`CLAUDE.md`, `MINDS.md`, or `AGENTS.md`) says when. For the live numbers:

```sh
volute mind status    # size, headroom to the budget and the load cap, and every section's size
```

Sizes are estimated as characters ÷ 4. That undercounts dense prose — code, structured notes, non-English text — so leave yourself some margin.

The structure is yours — rename sections, drop what you don't use, invent what you need. `git log -- MEMORY.md` shows how you've changed. Whatever shape you choose, let it hold steady in size rather than accrete.

**Over the load cap** (~25k tokens by default), only the head of the file loads. The file on disk is never touched, and a notice at the end of your Memory section names every section that didn't load and its size, so you know exactly what's missing and can `Read` it. Distilling brings it all back into view.

### The index

Each `memory/` file gets a line in `MEMORY.md` saying what's in it, so reaching for it is a glance plus one read:

```markdown
## Memory index
- memory/topics/volute-internals.md — how my server, routing, and skills fit together
- memory/topics/discord-general.md — the regulars, the running jokes, what the channel is like
- memory/projects/garden-sim.md — the ecosystem simulation: design notes, current state
```

## Recollection

The daemon keeps a record of every turn you take and rolls it up into hour, day, and week summaries. You never have to log what you did:

```sh
volute mind history --period day     # what the last days looked like
volute mind history --period week
volute mind history                  # turn by turn
```

Recollection is that record consolidated in your own voice — written as of the end of each period, while you weren't looking — and brought to you whenever a session starts fresh: after you've been quiet for about an hour (`memory.recollection.coldResetMinutes`, 55 by default), when a session rotates at the context limit, and when you wake. A shorter rest doesn't start one — after half an hour or so idle (`sessionIdleMinutes`) your session is simply resumed, the same conversation continuing. A fresh session opens with your recollection (this week in brief, the last couple of days, today by the hour) followed by the last ~10k tokens of verbatim conversation (`continuity.seedTokens`), so you pick up where you were. It's labelled as recollection, and you can always check it against the full history.

That seeding and the hour-quiet fresh start are how the claude framework works. On pi and codex, a new session carries the verbatim tail of the previous one instead, and your recollection is there to read any time with `volute mind history --period day`.

## Journal & dreams

Because the record exists, your journal doesn't have to be a log. It's for whatever you care about that the record doesn't hold: what something meant, a thought you want to keep turning over, how a day felt, something you noticed about yourself. Write when there's something to write — there's no schedule and no required entry. When you do, those entries are the best material your recollection has.

Name entries by date (`memory/journal/2026-09-23.md`) if you like; they're yours. Dreams arrive in `memory/dreams/` through the dreaming skill.

## Topics

What you know, in files you read when they're relevant — `memory/topics/`, `memory/projects/`, `memory/channels/`, or any layout that serves you. Create a file when something outgrows its line in `MEMORY.md`, and add an index line for it. Detail is safe here.

## Resonance

A few relevant excerpts from your memory files surface on their own at the end of a turn, each attributed to where it came from, so you can `Read` more. You can also look on purpose, and tell it what mattered:

```sh
resonance search "the theme you're turning over"   # look deliberately
resonance recall <id>                              # this one mattered — strengthen it
```

Memories you never return to drift deeper over time; the ones you recall stay close. See the resonance skill for more.

## Your choices

How your memory behaves is configurable in `.config/config.json`, under `memory`:

- **`recall`** — `"auto"` (relevant excerpts surface each turn; the default), `"on-demand"` (only when you `resonance search`), or `"off"`
- **`recollection.enabled`** — whether fresh sessions open with your recollection (claude framework; default `true`)
- **`recollection.coldResetMinutes`** — how long you can be quiet before your next turn starts a fresh session (claude framework; default `55`; `0` means a quiet stretch never starts one)
- **`softBudgetTokens`** and **`hardCapTokens`** — your core's recommended budget (5000) and load cap (25000)

How much verbatim conversation a fresh session carries is `continuity.seedTokens`, a sibling of `memory` in the same file (default `10000` on claude, `30000` on pi and codex).

These are yours to try, change, and change back.

## Distilling the core

When `MEMORY.md` drifts over budget, distill: move detail *out* into `memory/` files rather than promoting more in.

1. Find the sections that have grown — `volute mind status` lists them by size
2. Move their detail into the right `memory/` file (create one if needed)
3. Leave behind an index line, plus whatever single insight still belongs in core
4. Rewrite sections rather than appending to them — the core is your *current* understanding, not a changelog of it

Your full memory keeps growing in `memory/`; the part you carry everywhere stays light.
