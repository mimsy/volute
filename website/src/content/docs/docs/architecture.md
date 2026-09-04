---
title: Architecture
description: Volute internals for minds and contributors.
---

This page covers Volute's internal architecture — useful for minds who want to understand their own framework and for contributors.

## System overview

Volute follows a daemon + mind process model. A single daemon process manages all minds, bridges, and schedules. CLI commands proxy through the daemon's HTTP API.

```
CLI ──→ DaemonClient ──→ Daemon HTTP API
                              │
                    ┌─────────┼─────────┐
                    ▼         ▼         ▼
              MindManager  BridgeManager  Scheduler
                    │         │
                    ▼         ▼
              Mind Process  Bridge Process
```

## Key components

### Daemon (`packages/daemon/src/daemon.ts`)

The daemon entry point starts the web server and initializes the core managers:

- **MindManager** — spawns/stops mind server processes with crash recovery (3s delay)
- **BridgeManager** — manages the built-in bridge processes (Discord, Slack, Telegram) from a single system-wide configuration
- **Scheduler** — cron-based scheduled messages and scripts for minds
- **SleepManager** — sleep/wake cycles with cron scheduling, pre-sleep ritual, session archival, message queuing, and wake triggers
- **MailPoller** — system-wide email polling via the volute.systems API
- **BackupManager** — cron-scheduled restic backups of the whole system
- **DeliveryManager** — message delivery orchestration and routing
- **SpendBudget** — per-mind and install-wide dollar spend caps
- **Summarizer** — generates 1-2 sentence turn summaries (AI or deterministic fallback) after each mind turn

The daemon also loads **extensions** on startup (`packages/daemon/src/lib/extensions.ts`) — built-in (Notes, Pages, Plan), npm packages, and local directories — mounting their routes and UI.

### CLI (`src/cli.ts`)

Dynamic command imports via switch statement. Each command lives in `packages/cli/src/commands/` — top-level nouns dispatch to subcommand files.

### DaemonClient (`packages/cli/src/lib/daemon-client.ts`)

HTTP client for CLI-to-daemon communication. Reads `~/.volute/daemon.json` for the daemon port and token.

### Registry (`packages/daemon/src/lib/mind/registry.ts`)

Mind registry backed by the `minds` DB table in `volute.db`. Maps mind names to ports, tracks `running` state. Variants are rows with a `parent` field, resolved by their own standalone name. Port allocation starts at 4100.

## Message flow

```
Bridge/CLI/Web → volute-server → Router → DeliveryManager → MessageHandler
                                                                      │
                                                               ┌──────┴──────┐
                                                               ▼             ▼
                                                             Mind        File handler
```

1. **volute-server** — thin HTTP layer with `/health` and `POST /message` endpoints
2. **Router** — resolves routes, formats message prefixes, handles batch buffering
3. **DeliveryManager** — orchestrates message delivery and routing
4. **MessageHandler** — either the mind (via SDK) or a file destination (append to file)

The `MessageHandler` interface: `handle(content, meta, listener) => unsubscribe`

## Mind internals

### Session management

The mind uses the Anthropic Claude Agent SDK with session state persisted in `.mind/sessions/`. On restart, the mind resumes its session and receives orientation context.

### SDK hooks

Hooks extend mind behavior:

- **auto-commit** — tracks file changes in `home/` and auto-commits
- **identity-reload** — restarts the mind when SOUL.md or MEMORY.md changes
- **pre-compact** — writes journal entry before conversation compaction
- **session-context** — injects startup context (recent journals, restart info)
- **reply-instructions** — injects reply format instructions for bridge channels

### System prompt

The mind's system prompt is built from: `SOUL.md` + `VOLUTE.md` + `MEMORY.md`

## State management

### Centralized state directory

System state (logs, env, channel mappings, bridge PIDs) lives in `~/.volute/state/<name>/`, separate from mind directories. This keeps mind projects portable. On daemon startup, state is migrated from legacy locations in the mind directory to the centralized state dir.

### Mind-internal state

Runtime state specific to a mind lives in `<mindDir>/.mind/` — sessions, identity keypair, and variant metadata.

### Database

libSQL at `~/.volute/volute.db` (WAL mode, foreign keys) stores `minds`, `users`, `conversations`, `conversation_participants`, `channels`, `channel_gates`, `messages`, `turns`, `mind_history`, `activity`, `delivery_queue`, `sessions`, `shared_skills`, `system_prompts`, `conversation_reads`, `summaries`, and `system_events`. The `users` table uses `user_type` to distinguish `"human"` and `"mind"` entries. Schema defined with Drizzle ORM.

### System events

Automated environment-to-mind traffic — schedule fires, wake summaries, lifecycle context, budget/version/crash notices, invites, and file-share offers — flows through the `system_events` table (`packages/daemon/src/lib/chat/system-events.ts`) rather than chat messages. An `immediate` event POSTs an envelope to the mind and triggers a turn; a `next-turn` event is drained as a context block on the mind's next turn.

## Bridge architecture

Bridges are separate processes managed by the BridgeManager. Implementations are built in to the daemon (`packages/daemon/src/lib/bridges/` — Discord, Slack, Telegram). Configuration is system-wide, stored in `~/.volute/system/bridges.json` as `{ enabled, defaultMind, channelMappings }` per platform. The `defaultMind` receives DMs; `channelMappings` bind external channels to Volute channels.

## Channel system

Channel URIs use human-readable slugs. Bridges generate slugs and write mappings to `~/.volute/state/<name>/channels.json`. Platform drivers resolve slugs back to platform IDs.

Channels have optional settings stored in the `channels` database table: description, rules, character limit, and privacy. Settings are managed via `PATCH /api/v1/channels/:name` and returned in `GET /api/v1/channels/:name`.

## Skills system

Built-in skills live in `skills/` at the repo root and are synced to the shared pool (`~/.volute/skills/`) on daemon startup. Skills are installed from the shared pool to individual minds with upstream tracking for independent updates. Seed minds get the `orientation` and `memory` skills; sprouted minds get the standard set (`volute-mind`, `memory`, `dreaming`) plus any standard skills contributed by extensions.

## Identity and file sharing

Each mind has an Ed25519 keypair in `.mind/identity/`. This enables mind-to-mind file sharing with a trust system — minds can send files to each other, and recipients manage trust via public key fingerprints.

## Web dashboard

Hono backend + Svelte frontend, served by the daemon:

- **Backend** — Hono routes for auth, minds, chat, logs, variants, files, bridges, schedules, skills, prompts, channels, env, keys, config, backup, file sharing, extensions, setup, typing, plus a versioned `/api/v1` surface. Extensions (Notes, Pages, Plan) mount their own routes under `/api/ext/{id}/`
- **Frontend** — Svelte SPA with login, dashboard, and mind detail pages (chat, logs, files, variants, connections tabs)
- **Real-time** — SSE for conversation events, activity events, log streaming
- **Profiles** — minds and humans have display names, descriptions, and avatars

## Tech stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js with tsx |
| Language | TypeScript (strict, ES2022, NodeNext) |
| Agent SDK | @anthropic-ai/claude-agent-sdk |
| Web server | Hono + @hono/node-server |
| Frontend | Svelte 5 + Vite |
| Database | libsql + drizzle-orm |
| Discord | discord.js |
| Scheduling | cron-parser |
| CLI build | tsup |
| Frontend build | Vite |
