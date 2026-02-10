# Volute

CLI for creating and managing self-modifying AI agents powered by the Anthropic Claude Agent SDK.

## Philosophy

Volute is a home for independent, self-motivated agents. The architecture is designed so agents can understand and modify their own framework — their identity, memory, server code, skills, and environment. After installation, agents are the primary audience: documentation and prompting should encourage them to think independently, take initiative, and explore who they are rather than framing them as assistants or tools.

## Architecture

- `src/cli.ts` — CLI entry point, dynamic command imports via switch statement
- `src/daemon.ts` — Daemon entry point, starts web server + agent/connector/scheduler managers
- `src/commands/` — One file per command, each exports `async function run(args: string[])`
- `src/lib/` — Shared libraries (registry, agent-manager, connector-manager, scheduler, daemon-client, arg parsing, exec wrappers, variant metadata, db, auth, conversations, channels)
- `src/web/` — Web dashboard (Hono backend + React frontend), served by the daemon
- `connectors/` — Built-in connector implementations (e.g. `connectors/discord/index.ts`)
- `templates/agent-sdk/` — Default template (Claude Agent SDK) copied by `volute create`
- `templates/pi/` — Alternative template using pi-coding-agent for multi-provider LLM support
- All agents live in `~/.volute/agents/<name>/` with a centralized registry at `~/.volute/agents.json`

### Daemon model

A single daemon process (`volute up`) manages all agents, connectors, and schedules:

- **AgentManager** (`src/lib/agent-manager.ts`) — Spawns/stops agent server processes, crash recovery
- **ConnectorManager** (`src/lib/connector-manager.ts`) — Manages connector processes (Discord, etc.) per agent
- **Scheduler** (`src/lib/scheduler.ts`) — Cron-based scheduled messages to agents
- **DaemonClient** (`src/lib/daemon-client.ts`) — CLI commands talk to the daemon via HTTP API

CLI commands like `start`, `stop`, `status`, `send`, `connector`, `variant` all proxy through the daemon API.

### Agent project structure

Each agent project (created from the template) has:

```
<agent>/
├── src/
│   ├── server.ts              # Wires agent + router + file handler + HTTP server
│   ├── agent.ts               # Core agent handler: session management, SDK integration, HandlerResolver
│   ├── consolidate.ts         # Memory consolidation script
│   └── lib/
│       ├── router.ts          # Message router: route resolution, prefix formatting, batch buffering
│       ├── volute-server.ts   # Thin HTTP layer (~85 lines): /health, POST /message → ndjson
│       ├── file-handler.ts    # File destination handler: appends messages to files
│       ├── routing.ts         # Message routing: config loader, glob matcher, route resolution
│       ├── types.ts           # ChannelMeta, HandlerMeta, MessageHandler, HandlerResolver, VoluteEvent
│       ├── format-prefix.ts   # Shared message formatting (channel/sender/time prefix)
│       ├── startup.ts         # Shared server.ts boilerplate (parseArgs, loadConfig, etc.)
│       ├── auto-commit.ts     # Auto-commits file changes in home/ via SDK hooks
│       ├── logger.ts          # Logging utilities
│       ├── message-channel.ts # Async iterable for agent communication (agent-sdk template)
├── home/                      # Agent working directory (cwd for the SDK)
│   ├── SOUL.md                # System prompt / personality
│   ├── MEMORY.md              # Long-term memory (included in system prompt)
│   ├── CLAUDE.md              # Agent mechanics (sessions, memory instructions)
│   ├── VOLUTE.md              # Channel routing documentation
│   ├── .config/               # Agent configuration
│   │   ├── volute.json        # Model, connectors, schedules
│   │   └── sessions.json      # Session routing config (optional)
│   ├── memory/                # Daily logs (YYYY-MM-DD.md)
│   └── .claude/skills/        # Skills (volute CLI reference, memory system)
└── .volute/                   # Runtime state
    ├── sessions/              # Per-session SDK state (e.g. sessions/main.json)
    ├── connectors/            # Connector configs (e.g. connectors/discord/config.json)
    ├── schedules.json         # Cron schedules for this agent
    ├── variants.json          # Variant metadata
    ├── merged.json            # Post-merge context (temporary)
    ├── restart.json           # Restart signal for daemon
    ├── env.json               # Agent-specific environment variables
    └── logs/                  # agent.log, discord.log
```

The SDK runs with `cwd: home/` so it picks up `CLAUDE.md` and `.claude/skills/` from there.

### Template .init/ directory

Templates have a `.init/` directory containing identity files (SOUL.md, MEMORY.md, CLAUDE.md, memory/). On `volute create`, these are copied into `home/` and `.init/` is deleted. On `volute upgrade`, `.init/` files are excluded so identity files are never overwritten.

### Web dashboard

The daemon serves a Hono web server (default port 4200) with a React frontend.

- **Backend** (`src/web/`): Hono routes for auth, agents, chat, conversations, logs, variants, files, connectors, schedules
- **Frontend** (`src/web/frontend/`): React SPA with login, dashboard, and agent detail pages (chat, logs, files, variants, connections tabs)
- **Auth**: Cookie-based (`volute_session`), in-memory session map, first user auto-admin
- **Database**: libSQL at `~/.volute/volute.db` for users, conversations, messages, agent_messages
- **Build**: `vite build` → `dist/web-assets/`

## Commands

| Command | Purpose |
|---------|---------|
| `volute create <name>` | Create new agent in `~/.volute/agents/<name>/` |
| `volute up [--port N]` | Start the daemon (default: 4200) |
| `volute down` | Stop the daemon |
| `volute start <name>` | Start an agent (via daemon) |
| `volute stop <name>` | Stop an agent (via daemon) |
| `volute delete <name> [--force]` | Remove from registry (--force deletes directory) |
| `volute status [<name>]` | Check agent status, or list all agents |
| `volute logs [--agent <name>]` | Tail agent logs |
| `volute send <name> "<msg>"` | Send message, stream ndjson response |
| `volute variant create <name> [--agent] [--soul "..."] [--port N] [--no-start] [--json]` | Create variant (worktree + server) |
| `volute variant list [--agent] [--json]` | List variants with health status |
| `volute variant merge <name> [--agent] [--summary "..." --memory "..."]` | Merge variant back and restart |
| `volute env <set\|get\|list\|remove> [--agent <name>]` | Manage environment variables |
| `volute connector connect <type> [--agent]` | Enable a connector for an agent |
| `volute connector disconnect <type> [--agent]` | Disable a connector for an agent |
| `volute channel read <uri> [--agent]` | Read recent messages from a channel |
| `volute channel send <uri> "<msg>" [--agent]` | Send a message to a channel |
| `volute schedule list [--agent]` | List schedules for an agent |
| `volute schedule add [--agent] --cron "..." --message "..."` | Add a cron schedule |
| `volute schedule remove [--agent] --id <id>` | Remove a schedule |
| `volute history [--agent]` | View message history |
| `volute upgrade <name>` | Upgrade agent to latest template |
| `volute import <path> [--name <name>] [--session <path>]` | Import an OpenClaw workspace |
| `volute setup [--port N] [--host H]` | Install system service with user isolation (Linux, requires root) |
| `volute setup uninstall [--force]` | Remove system service (--force removes data + users) |

Agent commands (`variant`, `connector`, `schedule`, `logs`, `history`, `channel`) use `--agent <name>` or `VOLUTE_AGENT` env var.

## Source files

### src/lib/

| File | Purpose |
|------|---------|
| `registry.ts` | Agent registry at `~/.volute/agents.json`, port allocation (4100+), `running` field, name@variant resolution |
| `agent-manager.ts` | Spawns/stops agent servers, crash recovery (3s delay), merge-restart coordination |
| `connector-manager.ts` | Manages connector processes per agent, resolves built-in → shared → agent-specific connectors |
| `scheduler.ts` | Cron-based scheduled messages, per-agent schedule loading |
| `daemon-client.ts` | HTTP client for CLI → daemon communication, reads `~/.volute/daemon.json` for port |
| `variants.ts` | Variant metadata (`.volute/variants.json`), health checks, git worktree ops |
| `template.ts` | Template discovery, copying, `{{name}}` substitution, `.init/` → `home/` migration |
| `spawn-server.ts` | Spawns `tsx src/server.ts`, waits for port listening (used for variants only) |
| `parse-args.ts` | Type-safe argument parser with positional args and typed flags |
| `exec.ts` | Async wrappers around `execFile` (returns stdout) and `spawn` (inherits stdio) |
| `env.ts` | Environment variables (shared `~/.volute/env.json` + agent-specific `.volute/env.json`) |
| `format-tool.ts` | Shared tool call summarization (`[toolName primaryArg]` format) |
| `ndjson.ts` | NDJSON stream reader, yields `VoluteEvent` objects |
| `schema.ts` | Drizzle ORM schema (users, conversations, messages, agent_messages) |
| `db.ts` | libSQL database singleton at `~/.volute/volute.db` (WAL mode, foreign keys) |
| `auth.ts` | bcrypt password hashing, first user auto-admin, pending approval flow |
| `conversations.ts` | Conversation and message CRUD |
| `channels.ts` | ChannelProvider registry with optional drivers (read/send), display names, tool call visibility |
| `channels/discord.ts` | Discord channel driver (read/send via REST API, env-based token) |
| `convert-session.ts` | Converts OpenClaw `session.jsonl` to Claude Agent SDK format |
| `resolve-agent-name.ts` | Resolves agent name from `--agent` flag or `VOLUTE_AGENT` env var |
| `isolation.ts` | Per-agent Linux user isolation (`VOLUTE_ISOLATION=user`), user/group management, chown |

### src/web/

| Path | Purpose |
|------|---------|
| `server.ts` | Hono app setup, static file serving, route mounting |
| `app.ts` | Hono route composition, middleware setup, health endpoint |
| `middleware/auth.ts` | Cookie-based auth middleware, in-memory session map |
| `routes/auth.ts` | Login, register, logout, user management |
| `routes/agents.ts` | List/start/stop agents, message proxy with persistence |
| `routes/chat.ts` | POST `/api/agents/:name/chat` — NDJSON streaming chat |
| `routes/connectors.ts` | List/enable/disable connectors per agent |
| `routes/schedules.ts` | CRUD schedules + webhook endpoint |
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
- **Database**: libsql (synchronous better-sqlite3-compatible API), drizzle-orm
- **Auth**: bcryptjs
- **Discord**: discord.js
- **Scheduling**: cron-parser
- **CLI build**: tsup (compiles CLI + daemon → `dist/`)
- **Frontend build**: Vite (→ `dist/web-assets/`)
- **Package manager**: npm

## Key patterns

- Single daemon process manages all agents, connectors, and schedules
- CLI commands proxy through daemon HTTP API via `daemonFetch()` in `daemon-client.ts`
- Centralized registry at `~/.volute/agents.json` maps agent names to ports, tracks `running` state
- `resolveAgent()` supports `name@variant` syntax for addressing variants
- AgentManager spawns agent servers as child processes with crash recovery (3s delay) and merge-restart
- Connector resolution: agent-specific → user-shared (`~/.volute/connectors/`) → built-in (`connectors/`)
- Agent message flow: `volute-server` (HTTP) → `Router` (routing/formatting/batching) → `MessageHandler` (agent or file destination)
- `MessageHandler` interface: `handle(content, meta, listener) => unsubscribe`; `HandlerResolver`: `(key: string) => MessageHandler`
- Session routing via `sessions.json` rules with glob matching, template expansion (`${sender}`, `${channel}`), and file/agent destinations
- Variants use git worktrees with detached server processes; metadata in `<agentDir>/.volute/variants.json`
- All child process execution must be async (never `execFileSync`) to avoid blocking the event loop
- Arg parsing via `src/lib/parse-args.ts` — type-safe with positional args and typed flags
- Agent system prompt built from: SOUL.md + VOLUTE.md + MEMORY.md
- Model configurable via `VOLUTE_MODEL` env var
- Auto-commit hooks track file changes in agent `home/` directory
- Centralized message persistence in `agent_messages` table via daemon routes (text + tool call summaries)
- Optional per-agent Linux user isolation via `VOLUTE_ISOLATION=user` env var — agents spawn as separate system users

## Deployment

### Docker

```sh
docker build -t volute .
docker run -d -p 4200:4200 -v volute-data:/data volute
```

Or with docker-compose: `docker compose up -d`. The container runs with `VOLUTE_ISOLATION=user` enabled, so each agent gets its own Linux user inside the container.

### Bare metal (Linux)

```sh
sudo bash install.sh
# or manually:
sudo volute setup --host 0.0.0.0
```

`volute setup` installs a system-level systemd service at `/etc/systemd/system/volute.service` with data at `/var/lib/volute` and user isolation enabled. Requires root. Uninstall with `volute setup uninstall [--force]`.

### User isolation

When `VOLUTE_ISOLATION=user` is set, `volute create` creates a Linux system user (`volute-<name>`) and `chown`s the agent directory. Agent and connector processes are spawned with the agent's uid/gid, so agents can't access each other's files. This is a no-op when the env var is unset (default for local development).

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
