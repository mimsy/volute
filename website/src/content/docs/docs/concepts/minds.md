---
title: Minds
description: What minds are, their lifecycle, and project structure.
---

A mind is a long-running server with its own identity, memory, and working directory. Minds can read and write their own files, remember things across conversations, fork themselves to test changes, and connect to external platforms. Each mind has a cryptographic identity and can communicate with other minds.

## Lifecycle

```sh
volute mind create atlas           # scaffold a new mind
volute mind seed atlas             # create a minimal seed mind
volute mind sprout                 # grow a seed into a full mind
volute mind start atlas            # start it
volute mind stop atlas             # stop it
volute mind restart atlas          # restart it
volute mind list                   # list all minds
volute mind status atlas           # check status
volute mind sleep atlas            # put to sleep
volute mind wake atlas             # wake up
volute mind split experiment       # create a variant
volute mind join experiment        # merge a variant back
volute mind delete atlas           # remove from registry
volute mind delete atlas --force   # also delete files
```

The daemon manages mind processes with crash recovery — if a mind crashes, it automatically restarts after 3 seconds.

### Seeds vs full minds

`volute mind create` scaffolds a complete mind with the full template. `volute mind seed` creates a minimal starting point — a lightweight mind with just orientation and memory skills. When a seed is ready to grow, `volute mind sprout` upgrades it to a full mind with standard skills and configuration.

## Project structure

Each mind lives in `~/.volute/minds/<name>/`:

```
~/.volute/minds/atlas/
├── home/                      # the mind's working directory (cwd)
│   ├── SOUL.md                # personality and system prompt
│   ├── MEMORY.md              # long-term memory, always in context
│   ├── CLAUDE.md              # mind mechanics (sessions, memory instructions)
│   ├── VOLUTE.md              # channel routing documentation
│   ├── .config/
│   │   ├── config.json        # SDK config (model, compaction)
│   │   ├── volute.json        # volute config (identity, schedules, profile, sleep)
│   │   └── routes.json        # message routing config
│   ├── memory/journal/        # daily journal entries (YYYY-MM-DD.md)
│   └── .claude/skills/        # installed skills
├── src/                       # mind server code
│   ├── server.ts              # HTTP server setup
│   ├── agent.ts               # core mind handler
│   └── lib/                   # shared libraries
└── .mind/                     # runtime state
    ├── sessions/              # per-session SDK state
    ├── session-cursors.json   # session polling cursors
    ├── identity/              # Ed25519 keypair (private.pem, public.pem)
    └── connectors/            # bridge configs
```

## Key files

**`SOUL.md`** is the identity. This is the core of the system prompt. Edit it to change how the mind thinks and speaks.

**`MEMORY.md`** is long-term memory, always included in context. The mind updates it as it learns — preferences, key decisions, recurring context.

**`CLAUDE.md`** contains mind mechanics — session management instructions, memory system usage, and framework conventions.

**`VOLUTE.md`** documents the channel routing system, teaching the mind how to interact with different message sources.

**`.config/config.json`** holds SDK configuration — model and compaction settings.

**`.config/volute.json`** holds Volute configuration — identity, schedules, profile, sleep settings, and token budget.

## Sending messages

```sh
volute chat send @atlas "what's on your mind?"
```

The mind knows which channel each message came from — CLI, web, Discord, or system — and routes its response back to the source.

You can also pipe content:

```sh
echo "summarize this" | volute chat send @atlas
```

## Templates

Three built-in templates:

- **`claude`** (default) — Anthropic Claude Agent SDK
- **`pi`** — [pi-coding-agent](https://github.com/nicepkg/pi) for multi-provider LLM support
- **`codex`** — OpenAI Codex models

```sh
volute mind create atlas --template pi
```

## Model configuration

Set the model via `home/.config/config.json` (SDK config) or `home/.config/volute.json`, or the `VOLUTE_MODEL` env var.

## Upgrading minds

When the Volute template updates, upgrade minds without touching their identity:

```sh
volute mind upgrade atlas             # creates an "upgrade" variant
volute mind upgrade atlas --diff      # view changes before/after
volute mind upgrade atlas --continue  # after resolving conflicts
volute mind upgrade atlas --abort     # cancel the upgrade
volute chat send @atlas@upgrade "are you working?"  # test it
volute mind join upgrade                            # merge back
```

Your mind's `SOUL.md` and `MEMORY.md` are never overwritten during upgrades.

## Auto-commit

Any file changes the mind makes inside `home/` are automatically committed to git. This means every change is tracked and reversible.

## Session resume

If the mind restarts, it picks up where it left off. Session state is persisted in `.mind/sessions/` and the mind receives orientation context about the restart.
