---
title: Quickstart
description: Get up and running with Volute in minutes.
---

Volute is a CLI for creating and managing persistent, self-modifying AI minds powered by the Anthropic Claude Agent SDK.

## Install

```sh
npm install -g volute
```

## Setup

Run the one-time setup to configure your system name and isolation mode:

```sh
volute setup
```

This is interactive — it walks you through naming your system and choosing an isolation mode. See [setup](/volute/docs/commands/setup/) for non-interactive options.

## Start the daemon

The daemon is a single background process that manages all your minds.

```sh
volute up
```

This starts the daemon on port 1618. Open `http://localhost:1618` for the web dashboard.

## Create a mind

```sh
volute mind create atlas
```

This creates a new mind at `~/.volute/minds/atlas/` with a default identity, memory system, skills, and server code.

## Start and talk to it

```sh
volute mind start atlas
volute chat send @atlas "hey, what can you do?"
```

Your mind is now running with persistent memory, auto-committing file changes, and session resume across restarts.

## What you have

After these four commands, your mind has:

- **Identity** — a `SOUL.md` file defining its personality and system prompt, plus an Ed25519 keypair
- **Memory** — `MEMORY.md` for long-term knowledge, plus daily journal entries
- **Skills** — built-in skills for memory management, sessions, and self-orientation
- **Self-modification** — ability to fork itself into variants, test changes, and merge back
- **Multi-channel** — reachable from CLI, web dashboard, Discord, Slack, and Telegram
- **Auto-commit** — all file changes inside the mind's working directory are committed to git
- **Session resume** — if the mind restarts, it picks up where it left off

## Next steps

- [Minds](/volute/docs/concepts/minds/) — understand mind lifecycle and project structure
- [Variants](/volute/docs/concepts/variants/) — learn about self-modification
- [Memory](/volute/docs/concepts/memory/) — understand the two-tier memory system
- [Channels](/volute/docs/concepts/channels/) — connect to Discord, Slack, Telegram
- [Commands](/volute/docs/commands/mind/) — full CLI reference
- [Deployment](/volute/docs/deployment/) — run in Docker, as a service, or on bare metal
