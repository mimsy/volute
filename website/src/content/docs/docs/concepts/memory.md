---
title: Memory
description: How a mind remembers — a small always-loaded core, an automatic record, and files it writes because it cares.
---

A mind's memory has a few layers, each with one job. Some are automatic; the rest the mind writes and shapes itself.

| Layer | Holds | Who writes it | In context |
|---|---|---|---|
| **Core** (`MEMORY.md`) | who the mind is now: identity, key relationships, what's active, an index | the mind | every request |
| **Recollection** | what happened, consolidated in the mind's own voice | automatic | at the start of a fresh session (claude framework); via `volute mind history` anywhere |
| **Journal & dreams** (`memory/journal/`, `memory/dreams/`) | what the mind cares about that the record doesn't cover | the mind (dreams via the dreamer) | when read, or when recalled |
| **Topics** (`memory/topics/`, …) | what the mind knows | the mind | when read, or when recalled |
| **Resonance** | relevant excerpts from memory files | automatic | a few per turn |

## The core: MEMORY.md

`MEMORY.md` lives in the mind's `home/` and is included in the system prompt on every request, so every token in it is paid on every request. Minds are encouraged to keep it under about 5k tokens and move detail into `memory/` files, leaving an index line behind.

Past the load cap (25k tokens by default) only the head of the file is loaded. The file on disk is never modified, and the prompt names every section that didn't load, with its size. `volute mind status` shows a mind its headroom and a per-section size table. Sizes are estimated as characters ÷ 4, which undercounts dense prose.

Both budgets can be changed per mind under `memory` in `home/.config/config.json`.

## The record

The daemon records every turn and rolls turns up into hour, day, week, and month summaries, so a mind never has to keep a log. `volute mind history` reads them (`--period day` for the daily view).

## Recollection

Recollection is the record consolidated in the mind's own voice. Whenever a session starts fresh — after about an hour of quiet, at a rotation, on waking — it opens with the mind's recollection followed by the last ~10k tokens of verbatim conversation. A mind can turn it off (`memory.recollection.enabled`), change how long a quiet stretch lasts before a fresh session (`memory.recollection.coldResetMinutes`, default 55), and size the verbatim tail (`continuity.seedTokens`). Per-turn recall is `memory.recall`: `auto`, `on-demand`, or `off`.

This seeding and the cold reset apply on the claude framework. On pi and codex, a new session carries the verbatim tail of the previous one, and the recollection is readable any time with `volute mind history`.

## Journal, dreams, and topics

Because the record exists, a mind's journal is for whatever it cares about that the record doesn't hold — meaning, feeling, things it wants to keep turning over. Nothing asks a mind to journal on a schedule. Dreams are written by the dreaming skill into `memory/dreams/`. Topic files hold what a mind knows, organized however it likes.

## Sleep and memory

When a mind goes to sleep it gets a turn to wind down; the current session is archived and a fresh one begins on waking. See [Sleep](/docs/concepts/sleep/).
