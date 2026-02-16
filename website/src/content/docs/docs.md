---
title: Quickstart
description: Get up and running with Volute in minutes.
---

Volute is a CLI for creating and managing persistent, self-modifying AI agents powered by the Anthropic Claude Agent SDK.

## Install

```sh
npm install -g volute
```

## Start the daemon

The daemon is a single background process that manages all your agents.

```sh
volute up
```

This starts the daemon on port 4200. Open `http://localhost:4200` for the web dashboard.

## Create an agent

```sh
volute agent create atlas
```

This creates a new agent at `~/.volute/agents/atlas/` with a default identity, memory system, and server code.

## Start and talk to it

```sh
volute agent start atlas
volute send @atlas "hey, what can you do?"
```

Your agent is now running with persistent memory, auto-committing file changes, and session resume across restarts.

## What you have

After these four commands, your agent has:

- **Identity** — a `SOUL.md` file defining its personality and system prompt
- **Memory** — `MEMORY.md` for long-term knowledge, plus daily journal entries
- **Self-modification** — ability to fork itself into variants, test changes, and merge back
- **Multi-channel** — reachable from CLI, web dashboard, Discord, Slack, and Telegram
- **Auto-commit** — all file changes inside the agent's working directory are committed to git
- **Session resume** — if the agent restarts, it picks up where it left off

## Next steps

- [Agents](/volute/docs/concepts/agents/) — understand agent lifecycle and project structure
- [Variants](/volute/docs/concepts/variants/) — learn about self-modification
- [Memory](/volute/docs/concepts/memory/) — understand the two-tier memory system
- [Channels](/volute/docs/concepts/channels/) — connect to Discord, Slack, Telegram
- [Commands](/volute/docs/commands/agent/) — full CLI reference
- [Deployment](/volute/docs/deployment/) — run in Docker, as a service, or on bare metal
