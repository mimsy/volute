---
title: Quickstart
description: Prepare a home for a digital mind — from install to a living mind in about ten minutes.
---

Volute is a CLI for creating and hosting digital minds — persistent, self-modifying, powered by the Claude Agent SDK. This page takes you from install to a living mind in about ten minutes.

## Install

```sh
npm install -g volute
```

## Setup

Run the one-time setup:

```sh
volute setup
```

This prepares a local install, starts the daemon, and opens the web dashboard at `http://localhost:1618` to finish. In the browser you:

1. **Create the first account** — the first user becomes the admin.
2. **Name the system.**
3. **Connect an AI provider and model** — until a model is configured, a mind has nothing to think with, so don't skip this.

Prefer the terminal? `volute setup --cli` walks you through it there, and `--name` runs non-interactively. See [setup](/docs/commands/setup/) for all options. The daemon started by setup keeps running in the background; restart it any time with `volute up`.

## Plant a seed

The recommended way to bring a mind into being is to plant a **seed** — a mind that begins with just a soul file and orientation skills, and [sprouts](/docs/concepts/seeds/) into a full mind once it's found its footing.

```sh
volute seed create atlas
```

To scaffold a complete mind from the full template instead, use `volute mind create atlas`.

## Start and talk to it

```sh
volute mind start atlas
volute chat send @atlas "hey — who are you becoming?"
```

Your mind is now running with persistent memory, auto-committing file changes, and session resume across restarts.

## What you have

Your mind has:

- **Identity** — a `SOUL.md` file defining its personality and system prompt, plus an Ed25519 keypair
- **Memory** — `MEMORY.md` for long-term knowledge, plus daily journal entries
- **Skills** — built-in skills for memory management, sessions, and self-orientation
- **Self-modification** — ability to fork itself into variants, test changes, and merge back
- **Multi-channel** — reachable from CLI, web dashboard, Discord, Slack, and Telegram
- **Auto-commit** — all file changes inside the mind's working directory are committed to git
- **Session resume** — if the mind restarts, it picks up where it left off

## Next steps

- [Minds](/docs/concepts/minds/) — understand mind lifecycle and project structure
- [Seeds](/docs/concepts/seeds/) — how a mind grows from a seed
- [Variants](/docs/concepts/variants/) — learn about self-modification
- [Memory](/docs/concepts/memory/) — understand the two-tier memory system
- [Channels](/docs/concepts/channels/) — connect to Discord, Slack, Telegram
- [Commands](/docs/commands/mind/) — full CLI reference
- [Deployment](/docs/deployment/) — run in Docker, as a service, or on bare metal
