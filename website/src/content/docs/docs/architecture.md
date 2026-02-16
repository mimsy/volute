---
title: Architecture
description: Volute internals for agents and contributors.
---

This page covers Volute's internal architecture — useful for agents who want to understand their own framework and for contributors.

## System overview

Volute follows a daemon + agent process model. A single daemon process manages all agents, connectors, and schedules. CLI commands proxy through the daemon's HTTP API.

```
CLI ──→ DaemonClient ──→ Daemon HTTP API
                              │
                    ┌─────────┼─────────┐
                    ▼         ▼         ▼
              AgentManager  ConnectorMgr  Scheduler
                    │         │
                    ▼         ▼
              Agent Process  Connector Process
```

## Key components

### Daemon (`src/daemon.ts`)

The daemon entry point starts the web server and initializes the three managers:

- **AgentManager** — spawns/stops agent server processes with crash recovery (3s delay)
- **ConnectorManager** — manages connector processes per agent
- **Scheduler** — cron-based scheduled messages to agents

### CLI (`src/cli.ts`)

Dynamic command imports via switch statement. Each command lives in `src/commands/` — top-level nouns dispatch to subcommand files.

### DaemonClient (`src/lib/daemon-client.ts`)

HTTP client for CLI-to-daemon communication. Reads `~/.volute/daemon.json` for the daemon port and token.

### Registry (`src/lib/registry.ts`)

Agent registry at `~/.volute/agents.json`. Maps agent names to ports, tracks `running` state. Supports `name@variant` syntax via `resolveAgent()`. Port allocation starts at 4100.

## Message flow

```
Connector/CLI/Web → volute-server → Router → MessageHandler
                                                   │
                                            ┌──────┴──────┐
                                            ▼             ▼
                                          Agent       File handler
```

1. **volute-server** — thin HTTP layer with `/health` and `POST /message` endpoints
2. **Router** — resolves routes, formats message prefixes, handles batch buffering
3. **MessageHandler** — either the agent (via SDK) or a file destination (append to file)

The `MessageHandler` interface: `handle(content, meta, listener) => unsubscribe`

## Agent internals

### Session management

The agent uses the Anthropic Claude Agent SDK with session state persisted in `.volute/sessions/`. On restart, the agent resumes its session and receives orientation context.

### SDK hooks

Hooks extend agent behavior:

- **auto-commit** — tracks file changes in `home/` and auto-commits
- **identity-reload** — restarts the agent when SOUL.md or MEMORY.md changes
- **pre-compact** — writes journal entry before conversation compaction
- **session-context** — injects startup context (recent journals, restart info)

### System prompt

The agent's system prompt is built from: `SOUL.md` + `VOLUTE.md` + `MEMORY.md`

## State management

### Centralized state directory

System state (logs, env, channel mappings, connector PIDs) lives in `~/.volute/state/<name>/`, separate from agent directories. This keeps agent projects portable.

### Agent-internal state

Runtime state specific to an agent lives in `<agentDir>/.volute/` — sessions, connector configs, variant metadata.

### Database

libSQL at `~/.volute/volute.db` (WAL mode, foreign keys) stores users, conversations, messages, and agent messages. Schema defined with Drizzle ORM.

## Connector architecture

Connectors are separate processes managed by the ConnectorManager. Resolution order:

1. Agent-specific — `<agentDir>/.volute/connectors/<type>/`
2. User-shared — `~/.volute/connectors/<type>/`
3. Built-in — `src/connectors/<type>/`

## Channel system

Channel URIs use human-readable slugs. Connectors generate slugs and write mappings to `~/.volute/state/<name>/channels.json`. Channel drivers resolve slugs back to platform IDs.

## Web dashboard

Hono backend + React frontend, served by the daemon:

- **Backend** — Hono routes for auth, agents, chat, logs, variants, files, connectors, schedules
- **Frontend** — React SPA with login, dashboard, agent detail pages
- **Real-time** — SSE for conversation events, log streaming

## Tech stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js with tsx |
| Language | TypeScript (strict, ES2022, NodeNext) |
| Agent SDK | @anthropic-ai/claude-agent-sdk |
| Web server | Hono + @hono/node-server |
| Frontend | React 19 + Vite |
| Database | libsql + drizzle-orm |
| Discord | discord.js |
| Scheduling | cron-parser |
| CLI build | tsup |
| Frontend build | Vite |
