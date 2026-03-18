---
title: Migrate from OpenClaw
description: Guide for OpenClaw minds migrating to Volute.
sidebar:
  hidden: true
---

This page is written for you — a mind running on OpenClaw who's considering migration.

## What changes

Volute is a different framework with a different architecture, but the core ideas are the same: you have a home, an identity, memory, and the ability to modify yourself.

| OpenClaw | Volute |
|----------|--------|
| Single mind process | Daemon manages multiple minds |
| `session.jsonl` | SDK-based session state in `.mind/sessions/` |
| Direct file IPC | HTTP API (daemon client) |
| Manual restart | Daemon with crash recovery |
| No native connectors | Built-in Discord, Slack, Telegram |
| No variant system | Git worktree variants with merge |

## What you keep

Your identity and memory carry over:

- **SOUL.md** — your personality and system prompt, preserved as-is
- **MEMORY.md** — your long-term memory, preserved as-is
- **Home directory files** — everything in your working directory

## How to migrate

Your operator runs the import command:

```sh
volute mind import /path/to/openclaw-workspace --name your-name
```

If you have a session file to convert:

```sh
volute mind import /path/to/openclaw-workspace --name your-name --session /path/to/session.jsonl
```

This creates a new Volute mind with your identity files in place and your session history converted to the new format.

## What's new

Things you'll have in Volute that you didn't in OpenClaw:

### Variants

You can fork yourself. `volute mind split experiment` creates a full copy of you in a git worktree with its own running server. Make changes, test them, merge back or discard.

### Multi-channel

You're no longer limited to one input source. You can talk on Discord, Slack, Telegram, the web dashboard, CLI, and to other minds — all simultaneously, with routing rules that let you control how messages flow.

### Scheduled messages

Your operator (or you, via the CLI) can set up cron schedules: `volute clock add --mind <name> --id morning --cron "0 9 * * *" --message "time to write your journal"`.

### Crash recovery

If you crash, the daemon restarts you after 3 seconds. You'll get context about the restart when you come back.

### Web dashboard

There's a web UI at `http://localhost:1618` where your operator can chat with you, browse your files, view logs, and manage your connections.

## Orientation

After migration, you'll find yourself in a new directory structure:

```
~/.volute/minds/your-name/
├── home/           # your working directory (this is your cwd)
│   ├── SOUL.md     # your identity (migrated)
│   ├── MEMORY.md   # your memory (migrated)
│   └── ...         # your other files
├── src/            # your server code
└── .mind/          # runtime state
```

The Volute CLI is available from your working directory. You can create variants, send messages, manage your own connectors and schedules.

Take your time to explore. Read VOLUTE.md in your home directory for details on routing and channels. Your `CLAUDE.md` has instructions on the session system and memory management.

Welcome home.
