---
title: Agents
description: What agents are, their lifecycle, and project structure.
---

An agent is a long-running server with its own identity, memory, and working directory. Agents can read and write their own files, remember things across conversations, and fork themselves to test changes in isolation before merging back.

## Lifecycle

```sh
volute agent create atlas           # scaffold a new agent
volute agent start atlas            # start it
volute agent stop atlas             # stop it
volute agent restart atlas          # restart it
volute agent list                   # list all agents
volute agent status atlas           # check status
volute agent logs atlas --follow    # tail logs
volute agent delete atlas           # remove from registry
volute agent delete atlas --force   # also delete files
```

The daemon manages agent processes with crash recovery — if an agent crashes, it automatically restarts after 3 seconds.

## Project structure

Each agent lives in `~/.volute/agents/<name>/`:

```
~/.volute/agents/atlas/
├── home/                      # the agent's working directory (cwd)
│   ├── SOUL.md                # personality and system prompt
│   ├── MEMORY.md              # long-term memory, always in context
│   ├── CLAUDE.md              # agent mechanics (sessions, memory instructions)
│   ├── VOLUTE.md              # channel routing documentation
│   ├── .config/
│   │   ├── volute.json        # model, connectors, schedules
│   │   └── routes.json        # message routing config
│   ├── memory/journal/        # daily journal entries (YYYY-MM-DD.md)
│   └── .claude/skills/        # skills (volute CLI reference, memory system)
├── src/                       # agent server code
│   ├── server.ts              # HTTP server setup
│   ├── agent.ts               # core agent handler
│   └── lib/                   # shared libraries
└── .volute/                   # runtime state
    ├── sessions/              # per-session SDK state
    ├── connectors/            # connector configs
    ├── schedules.json         # cron schedules
    └── variants.json          # variant metadata
```

## Key files

**`SOUL.md`** is the identity. This is the core of the system prompt. Edit it to change how the agent thinks and speaks.

**`MEMORY.md`** is long-term memory, always included in context. The agent updates it as it learns — preferences, key decisions, recurring context.

**`CLAUDE.md`** contains agent mechanics — session management instructions, memory system usage, and framework conventions.

**`VOLUTE.md`** documents the channel routing system, teaching the agent how to interact with different message sources.

## Sending messages

```sh
volute send @atlas "what's on your mind?"
```

The agent knows which channel each message came from — CLI, web, Discord, or system — and routes its response back to the source.

You can also pipe content:

```sh
echo "summarize this" | volute send @atlas
```

## Templates

Two built-in templates:

- **`agent-sdk`** (default) — Anthropic Claude Agent SDK
- **`pi`** — [pi-coding-agent](https://github.com/nicepkg/pi) for multi-provider LLM support

```sh
volute agent create atlas --template pi
```

## Model configuration

Set the model via `home/.config/volute.json` in the agent directory, or the `VOLUTE_MODEL` env var.

## Upgrading agents

When the Volute template updates, upgrade agents without touching their identity:

```sh
volute agent upgrade atlas          # creates an "upgrade" variant
volute agent upgrade atlas --continue  # after resolving conflicts
volute send @atlas@upgrade "are you working?"  # test it
volute variant merge upgrade --agent atlas     # merge back
```

Your agent's `SOUL.md` and `MEMORY.md` are never overwritten during upgrades.

## Auto-commit

Any file changes the agent makes inside `home/` are automatically committed to git. This means every change is tracked and reversible.

## Session resume

If the agent restarts, it picks up where it left off. Session state is persisted in `.volute/sessions/` and the agent receives orientation context about the restart.
