# Volute

CLI for creating and managing self-modifying AI agents powered by the Anthropic Claude Agent SDK.

## Architecture

- `src/cli.ts` — Entry point, dynamic command imports via switch statement
- `src/commands/` — One file per command, each exports `async function run(args: string[])`
- `src/lib/` — Shared libraries (registry, supervisor, arg parsing, exec wrappers, variant metadata, db, auth, conversations, channels)
- `src/web/` — Web dashboard (Hono backend + React frontend)
- `templates/agent-sdk/` — Default template (Claude Agent SDK) copied by `volute create`
- `templates/pi/` — Alternative template using pi-coding-agent for multi-provider LLM support
- All agents live in `~/.volute/agents/<name>/` with a centralized registry at `~/.volute/agents.json`

### Agent project structure

Each agent project (created from the template) has:

```
<agent>/
├── src/
│   ├── server.ts              # HTTP server with /health and POST /message (ndjson streaming)
│   ├── consolidate.ts         # Memory consolidation script
│   └── lib/
│       ├── agent.ts           # SDK wrapper, broadcasts VoluteEvent, auto-commits file changes
│       ├── auto-commit.ts     # Auto-commits file changes in home/ via SDK hooks
│       ├── logger.ts          # Logging utilities
│       ├── message-channel.ts # Async iterable for agent communication
│       └── types.ts           # VoluteRequest, VoluteContentPart types
├── home/                      # Agent working directory (cwd for the SDK)
│   ├── SOUL.md                # System prompt / personality
│   ├── MEMORY.md              # Long-term memory (included in system prompt)
│   ├── CLAUDE.md              # Agent mechanics (sessions, memory instructions)
│   ├── VOLUTE.md              # Channel routing documentation
│   ├── memory/                # Daily logs (YYYY-MM-DD.md)
│   └── .claude/skills/        # Skills (volute CLI reference, memory system)
└── .volute/                   # Runtime state
    ├── session.json           # Session ID for resume
    ├── supervisor.pid         # Supervisor process ID
    ├── discord.pid            # Discord connector PID (if connected)
    ├── discord.json           # Discord connection info
    ├── variants.json          # Variant metadata
    ├── merged.json            # Post-merge context (temporary)
    ├── restart.json           # Restart signal for supervisor
    ├── env.json               # Agent-specific environment variables
    └── logs/                  # supervisor.log, discord.log
```

The SDK runs with `cwd: home/` so it picks up `CLAUDE.md` and `.claude/skills/` from there.

### Template .init/ directory

Templates have a `.init/` directory containing identity files (SOUL.md, MEMORY.md, CLAUDE.md, memory/). On `volute create`, these are copied into `home/` and `.init/` is deleted. On `volute upgrade`, `.init/` files are excluded so identity files are never overwritten.

### Web dashboard

`volute ui` starts a Hono web server (default port 4200) with a React frontend.

- **Backend** (`src/web/`): Hono routes for auth, agents, chat, conversations, logs, variants, files
- **Frontend** (`src/web/frontend/`): React SPA with login, dashboard, and agent detail pages (chat, logs, files, variants, connections tabs)
- **Auth**: Cookie-based (`volute_session`), in-memory session map, first user auto-admin
- **Database**: libSQL at `~/.volute/volute.db` for users, conversations, messages
- **Build**: `vite build` → `dist/web-assets/`

## Commands

| Command | Purpose |
|---------|---------|
| `volute create <name>` | Create new agent in `~/.volute/agents/<name>/` |
| `volute start <name> [--foreground] [--dev]` | Start agent (daemonized by default) |
| `volute stop <name>` | Stop the agent |
| `volute delete <name> [--force]` | Remove from registry (--force deletes directory) |
| `volute status [<name>]` | Check agent status, or list all agents |
| `volute logs <name> [--follow] [-n N]` | Tail agent logs |
| `volute send <name> "<msg>"` | Send message, stream ndjson response |
| `volute ui [--port N]` | Start web dashboard (default: 4200) |
| `volute fork <name> <variant> [--soul "..."] [--port N] [--no-start] [--json]` | Create variant (worktree + server) |
| `volute variants <name> [--json]` | List variants with health status |
| `volute merge <name> <variant> [--summary "..." --memory "..."]` | Merge variant back and restart |
| `volute env <set\|get\|list\|remove> [--agent <name>]` | Manage environment variables |
| `volute connect discord <name>` | Connect Discord bot to agent (daemonized) |
| `volute disconnect discord <name>` | Stop Discord bot connector |
| `volute channel read <uri>` | Read recent messages from a channel |
| `volute channel send <uri> "<msg>"` | Send a message to a channel |
| `volute upgrade <name>` | Upgrade agent to latest template |
| `volute import <path> [--name <name>] [--session <path>]` | Import an OpenClaw workspace |

## Source files

### src/lib/

| File | Purpose |
|------|---------|
| `registry.ts` | Agent registry at `~/.volute/agents.json`, port allocation (4100+), name@variant resolution |
| `supervisor.ts` | Spawns agent server, crash recovery (3s delay), merge-restart coordination |
| `variants.ts` | Variant metadata (`.volute/variants.json`), health checks, git worktree ops |
| `template.ts` | Template discovery, copying, `{{name}}` substitution, `.init/` → `home/` migration |
| `spawn-server.ts` | Spawns `tsx src/server.ts`, waits for port listening, supports detached mode |
| `parse-args.ts` | Type-safe argument parser with positional args and typed flags |
| `exec.ts` | Async wrappers around `execFile` (returns stdout) and `spawn` (inherits stdio) |
| `env.ts` | Environment variables (shared `~/.volute/env.json` + agent-specific `.volute/env.json`) |
| `ndjson.ts` | NDJSON stream reader, yields `VoluteEvent` objects |
| `db.ts` | libSQL database singleton at `~/.volute/volute.db` (WAL mode, foreign keys) |
| `auth.ts` | bcrypt password hashing, first user auto-admin, pending approval flow |
| `conversations.ts` | Conversation and message CRUD |
| `channels.ts` | Channel config (web, discord, cli, system), controls tool call visibility |
| `channels/discord.ts` | Discord API client (read/send messages) |
| `convert-session.ts` | Converts OpenClaw `session.jsonl` to Claude Agent SDK format |

### src/web/

| Path | Purpose |
|------|---------|
| `server.ts` | Hono app setup, static file serving, route mounting |
| `middleware/auth.ts` | Cookie-based auth middleware, in-memory session map |
| `routes/auth.ts` | Login, register, logout, user management |
| `routes/agents.ts` | List/start/stop/fork/merge agents |
| `routes/chat.ts` | POST `/api/agents/:name/chat` — NDJSON streaming chat |
| `routes/conversations.ts` | Conversation listing |
| `routes/logs.ts` | Log streaming |
| `routes/variants.ts` | Variant listing |
| `routes/files.ts` | Read/write agent files |

## Tech stack

- **Runtime**: Node.js with tsx
- **Language**: TypeScript (strict, ES2022, NodeNext modules)
- **Agent SDK**: `@anthropic-ai/claude-agent-sdk`
- **Web server**: Hono + @hono/node-server
- **Frontend**: React 19 + Vite
- **Database**: libsql (synchronous better-sqlite3-compatible API)
- **Auth**: bcryptjs
- **Discord**: discord.js
- **CLI build**: tsup (compiles CLI → `dist/cli.js`)
- **Frontend build**: Vite (→ `dist/web-assets/`)
- **Package manager**: npm

## Key patterns

- Centralized registry at `~/.volute/agents.json` maps agent names to ports
- `resolveAgent()` supports `name@variant` syntax for addressing variants
- Supervisor runs in the CLI process, spawns the agent server, handles crash recovery (3s delay) and merge-restart
- Agent servers use HTTP with ndjson streaming (`/health`, `POST /message` → ndjson response)
- Variants use git worktrees with detached server processes; metadata in `<agentDir>/.volute/variants.json`
- All child process execution must be async (never `execFileSync`) to avoid blocking the event loop
- Arg parsing via `src/lib/parse-args.ts` — type-safe with positional args and typed flags
- Channel abstraction routes messages between web, Discord, CLI, and system sources
- Agent system prompt built from: SOUL.md + VOLUTE.md + MEMORY.md
- Model configurable via `VOLUTE_MODEL` env var
- Auto-commit hooks track file changes in agent `home/` directory

## Development

```sh
npm install              # install dependencies
npm run dev              # run CLI in dev mode (via tsx)
npm run build            # build CLI + web frontend
npm run dev:web          # run frontend dev server
npm test                 # run tests
```

The CLI is installed globally via `npm link` (requires `npm run build` first) or run in dev mode via `tsx src/cli.ts`.

Tests run with `node --import tsx --test test/*.test.ts`.
