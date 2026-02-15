# Volute

CLI for creating and managing self-modifying AI agents powered by the Anthropic Claude Agent SDK.

## Philosophy

Volute is a home for independent, self-motivated agents. The architecture is designed so agents can understand and modify their own framework — their identity, memory, server code, skills, and environment. After installation, agents are the primary audience: documentation and prompting should encourage them to think independently, take initiative, and explore who they are rather than framing them as assistants or tools.

## Architecture

- `src/cli.ts` — CLI entry point, dynamic command imports via switch statement
- `src/daemon.ts` — Daemon entry point, starts web server + agent/connector/scheduler managers
- `src/commands/` — One file per command, each exports `async function run(args: string[])`. Top-level nouns (`agent.ts`, `channel.ts`, `connector.ts`, `env.ts`, `schedule.ts`, `service.ts`, `setup.ts`, `variant.ts`) dispatch to subcommand files.
- `src/lib/` — Shared libraries (registry, agent-manager, connector-manager, scheduler, daemon-client, arg parsing, exec wrappers, variant metadata, db, auth, conversations, channels)
- `src/web/` — Web dashboard (Hono backend + React frontend), served by the daemon
- `src/connectors/` — Built-in connector implementations (Discord, Slack, Telegram) + shared SDK
- `templates/agent-sdk/` — Default template (Claude Agent SDK) copied by `volute agent create`
- `templates/pi/` — Alternative template using pi-coding-agent for multi-provider LLM support
- All agents live in `~/.volute/agents/<name>/` by default (overridable via `VOLUTE_AGENTS_DIR`) with a centralized registry at `~/.volute/agents.json`

### Daemon model

A single daemon process (`volute up`) manages all agents, connectors, and schedules:

- **AgentManager** (`src/lib/agent-manager.ts`) — Spawns/stops agent server processes, crash recovery
- **ConnectorManager** (`src/lib/connector-manager.ts`) — Manages connector processes (Discord, etc.) per agent
- **Scheduler** (`src/lib/scheduler.ts`) — Cron-based scheduled messages to agents
- **DaemonClient** (`src/lib/daemon-client.ts`) — CLI commands talk to the daemon via HTTP API

CLI commands like `agent start`, `agent stop`, `message send`, `connector`, `variant` all proxy through the daemon API.

### Centralized state directory

Volute system state (logs, env, channel mappings, connector PIDs) lives in `~/.volute/state/<name>/`, separate from agent directories. This keeps agent projects portable — they contain only agent-owned state (sessions, cursors, connector configs). The `stateDir(name)` helper in `src/lib/registry.ts` resolves state paths. On daemon startup, `migrateAgentState()` copies any legacy `.volute/env.json`, `.volute/channels.json`, and `.volute/logs/` from agent directories to the centralized state dir.

Agents receive `VOLUTE_AGENT`, `VOLUTE_STATE_DIR`, `VOLUTE_AGENT_DIR`, `VOLUTE_AGENT_PORT`, `VOLUTE_DAEMON_PORT`, and `VOLUTE_DAEMON_TOKEN` env vars from the daemon (via `process.env` inheritance). Instead of file-based IPC (restart.json, merged.json), agents call the daemon's REST API via `daemonRestart()` and `daemonSend()` from `templates/_base/src/lib/daemon-client.ts`. The daemon delivers post-restart context (merge info) to agents via HTTP POST to the agent's `/message` endpoint.

### Agent project structure

Each agent project (created from the template) has:

```
<agent>/
├── src/
│   ├── server.ts              # Wires agent + router + file handler + HTTP server
│   ├── agent.ts               # Core agent handler: session management, SDK integration, HandlerResolver
│   └── lib/
│       ├── router.ts          # Message router: route resolution, prefix formatting, batch buffering
│       ├── volute-server.ts   # Thin HTTP layer: /health, POST /message → JSON response
│       ├── file-handler.ts    # File destination handler: appends messages to files
│       ├── routing.ts         # Message routing: config loader, glob matcher, route resolution
│       ├── types.ts           # ChannelMeta, HandlerMeta, MessageHandler, HandlerResolver, VoluteEvent
│       ├── format-prefix.ts   # Shared message formatting (channel/sender/time prefix)
│       ├── startup.ts         # Shared server.ts boilerplate (parseArgs, loadConfig, etc.)
│       ├── auto-commit.ts     # Auto-commits file changes in home/ via SDK hooks
│       ├── auto-reply.ts      # Auto-reply tracker for sending text output back to channels
│       ├── daemon-client.ts   # Agent-side daemon API client (daemonRestart, daemonSend)
│       ├── session-monitor.ts # Session activity tracking and cross-session summaries
│       ├── logger.ts          # Logging utilities
│       ├── message-channel.ts # Async iterable for agent communication (agent-sdk template only)
│       ├── content.ts         # Content extraction from SDK events (agent-sdk template only)
│       ├── session-store.ts   # Session state persistence (agent-sdk template only)
│       ├── stream-consumer.ts # SDK stream event consumer (agent-sdk template only)
│       └── hooks/             # SDK hooks (agent-sdk template only)
│           ├── auto-commit.ts     # File change auto-commit hook
│           ├── identity-reload.ts # Restart on SOUL.md/MEMORY.md change
│           ├── pre-compact.ts     # Journal update before compaction
│           └── session-context.ts # Startup context injection
├── home/                      # Agent working directory (cwd for the SDK)
│   ├── SOUL.md                # System prompt / personality
│   ├── MEMORY.md              # Long-term memory (included in system prompt)
│   ├── CLAUDE.md              # Agent mechanics (sessions, memory instructions)
│   ├── VOLUTE.md              # Channel routing documentation
│   ├── .config/               # Agent configuration
│   │   ├── volute.json        # Model, connectors, schedules
│   │   └── routes.json        # Message routing config (optional)
│   ├── memory/journal/        # Daily journal entries (YYYY-MM-DD.md)
│   └── .claude/skills/        # Skills (volute CLI reference, memory system)
└── .volute/                   # Agent-internal runtime state
    ├── sessions/              # Per-session SDK state (e.g. sessions/main.json)
    ├── session-cursors.json   # Session polling cursors
    ├── connectors/            # Connector configs (e.g. connectors/discord/config.json)
    ├── schedules.json         # Cron schedules for this agent
    └── variants.json          # Variant metadata
```

The SDK runs with `cwd: home/` so it picks up `CLAUDE.md` and `.claude/skills/` from there.

### Template .init/ directory

Templates have a `.init/` directory containing identity and config files. On `volute agent create`, these are copied into `home/` and `.init/` is deleted. On `volute agent upgrade`, `.init/` files are excluded so identity files are never overwritten.

- **`_base/.init/`**: SOUL.md, MEMORY.md, memory/journal/, .config/hooks/startup-context.sh, .config/scripts/session-reader.ts
- **`agent-sdk/.init/`**: CLAUDE.md, .claude/settings.json, .config/routes.json
- **`pi/.init/`**: AGENTS.md, .config/routes.json

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
| `volute agent create <name>` | Create new agent in `~/.volute/agents/<name>/` |
| `volute agent start <name>` | Start an agent (via daemon) |
| `volute agent stop <name>` | Stop an agent (via daemon) |
| `volute agent delete <name> [--force]` | Remove from registry (--force deletes directory) |
| `volute agent list` | List all agents |
| `volute agent status <name>` | Check agent status |
| `volute agent logs <name> [--follow] [-n N]` | Tail agent logs |
| `volute agent restart <name>` | Restart an agent |
| `volute agent upgrade <name>` | Upgrade agent to latest template |
| `volute agent import <path> [--name <name>] [--session <path>]` | Import an OpenClaw workspace |
| `volute send <target> "<msg>" [--agent]` | Send a message (DM, channel, cross-platform) |
| `volute history [--agent] [--channel <ch>] [--limit N]` | View message history |
| `volute variant create <name> [--agent] [--soul "..."] [--port N] [--no-start] [--json]` | Create variant (worktree + server) |
| `volute variant list [--agent] [--json]` | List variants with health status |
| `volute variant merge <name> [--agent] [--summary "..." --memory "..." --justification "..."]` | Merge variant back and restart |
| `volute variant delete <name> [--agent]` | Delete a variant |
| `volute env <set\|get\|list\|remove> [--agent] [--reveal]` | Manage environment variables |
| `volute connector connect <type> [--agent]` | Enable a connector for an agent |
| `volute connector disconnect <type> [--agent]` | Disable a connector for an agent |
| `volute channel read <uri> [--agent] [--limit N]` | Read recent messages from a channel |
| `volute channel list [<platform>] [--agent]` | List conversations on a platform |
| `volute channel users <platform> [--agent]` | List users/contacts on a platform |
| `volute channel create <platform> --participants u1,u2 [--agent]` | Create a conversation on a platform |
| `volute channel typing <uri> [--agent]` | Check who is typing in a channel |
| `volute schedule list [--agent]` | List schedules for an agent |
| `volute schedule add [--agent] --cron "..." --message "..." [--id name]` | Add a cron schedule |
| `volute schedule remove [--agent] --id <id>` | Remove a schedule |
| `volute up [--port N] [--foreground]` | Start the daemon (default: 4200) |
| `volute down` | Stop the daemon |
| `volute restart [--port N]` | Restart the daemon |
| `volute service install [--port N] [--host H]` | Install as user-level auto-start service |
| `volute service uninstall` | Remove user-level service |
| `volute service status` | Check service status |
| `volute setup [--port N] [--host H]` | Install system service with user isolation (Linux, requires root) |
| `volute setup uninstall [--force]` | Remove system service (--force removes data + users) |
| `volute update` | Check for updates |

Agent-scoped commands (`send`, `history`, `variant`, `connector`, `schedule`, `channel`) use `--agent <name>` or `VOLUTE_AGENT` env var.

## Source files

### src/lib/

| File | Purpose |
|------|---------|
| `registry.ts` | Agent registry at `~/.volute/agents.json`, port allocation (4100+), `running` field, name@variant resolution |
| `agent-manager.ts` | Spawns/stops agent servers, crash recovery (3s delay), merge-restart coordination |
| `connector-manager.ts` | Manages connector processes per agent, resolves built-in → shared → agent-specific connectors |
| `connector-defs.ts` | Connector type definitions and metadata |
| `scheduler.ts` | Cron-based scheduled messages, per-agent schedule loading |
| `daemon-client.ts` | HTTP client for CLI → daemon communication, reads `~/.volute/daemon.json` for port |
| `variants.ts` | Variant metadata (`.volute/variants.json`), health checks, git worktree ops |
| `template.ts` | Template discovery, copying, `{{name}}` substitution, `.init/` → `home/` migration |
| `spawn-server.ts` | Spawns `tsx src/server.ts`, waits for port listening (used for variants only) |
| `parse-args.ts` | Type-safe argument parser with positional args and typed flags |
| `parse-target.ts` | Parse send target strings (DMs, channels, platform URIs) |
| `exec.ts` | Async wrappers around `execFile` (returns stdout) and `spawn` (inherits stdio) |
| `env.ts` | Environment variables (shared `~/.volute/env.json` + agent-specific state dir env) |
| `format-tool.ts` | Shared tool call summarization (`[toolName primaryArg]` format) |
| `schema.ts` | Drizzle ORM schema (users, conversations, conversation_participants, messages, agent_messages, sessions) |
| `db.ts` | libSQL database singleton at `~/.volute/volute.db` (WAL mode, foreign keys) |
| `auth.ts` | bcrypt password hashing, first user auto-admin, pending approval flow, agent users |
| `conversations.ts` | Conversation and message CRUD, multi-participant conversations |
| `conversation-events.ts` | In-process pub-sub for conversation events, consumed by SSE endpoint |
| `channels.ts` | ChannelProvider registry with optional drivers (read/send), display names, slug resolution via `channels.json` |
| `channels/discord.ts` | Discord channel driver (read/send via REST API, slug-to-ID resolution) |
| `channels/slack.ts` | Slack channel driver (read/send via Slack API, slug-to-ID resolution) |
| `channels/telegram.ts` | Telegram channel driver (send via Bot API, slug-to-ID resolution; read not supported) |
| `channels/volute.ts` | Volute platform channel driver (conversations, DMs, group chats) |
| `slugify.ts` | Shared slugify function for generating human-readable channel slugs |
| `consolidate.ts` | Memory consolidation (reads daily logs, produces MEMORY.md via LLM) |
| `convert-session.ts` | Converts OpenClaw `session.jsonl` to Claude Agent SDK format |
| `json-state.ts` | JSON file state management utilities |
| `log-buffer.ts` | Log buffering utilities |
| `logger.ts` | Logging utilities |
| `migrate-state.ts` | Agent state migration from agent dirs to centralized state dir |
| `rotating-log.ts` | Size-limited rotating log files |
| `read-stdin.ts` | Reads piped stdin for send commands (returns undefined if TTY) |
| `resolve-agent-name.ts` | Resolves agent name from `--agent` flag or `VOLUTE_AGENT` env var |
| `token-budget.ts` | Per-agent token budget enforcement |
| `typing.ts` | Typing indicator tracking |
| `update-check.ts` | npm update check on CLI invocation |
| `verify.ts` | Agent verification utilities |
| `volute-config.ts` | Agent volute.json config reader |
| `isolation.ts` | Per-agent Linux user isolation (`VOLUTE_ISOLATION=user`), user/group management, chown |

### src/web/

| Path | Purpose |
|------|---------|
| `server.ts` | Hono app setup, static file serving, route mounting |
| `app.ts` | Hono route composition, middleware setup, health endpoint |
| `middleware/auth.ts` | Cookie-based auth middleware, in-memory session map |
| `routes/auth.ts` | Login, register, logout, user management |
| `routes/agents.ts` | List/start/stop agents, message proxy with persistence |
| `routes/connectors.ts` | List/enable/disable connectors per agent |
| `routes/schedules.ts` | CRUD schedules + webhook endpoint |
| `routes/logs.ts` | Log streaming |
| `routes/variants.ts` | Variant listing |
| `routes/files.ts` | Read/write agent files |
| `routes/system.ts` | System info and status |
| `routes/typing.ts` | Typing indicator endpoints |
| `routes/update.ts` | Update check endpoint |
| `routes/volute/chat.ts` | POST /chat — fire-and-forget to agents; GET /conversations/:id/events — SSE |
| `routes/volute/conversations.ts` | Conversation CRUD, group creation, participant management |
| `routes/volute/user-conversations.ts` | User-facing conversation list and management |

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
- Channel URIs use human-readable slugs: `discord:my-server/general`, `slack:workspace/channel`, `telegram:@username`, `volute:conversation-title`. Connectors generate slugs and write slug→platformId mappings to `~/.volute/state/<name>/channels.json`. Channel drivers resolve slugs back to platform IDs via this mapping.
- Connector resolution: agent-specific → user-shared (`~/.volute/connectors/`) → built-in (`src/connectors/`)
- Agent message flow: `volute-server` (JSON req/res) → `Router` (routing/formatting/batching) → `MessageHandler` (agent or file destination); web dashboard receives updates via SSE event channel
- `MessageHandler` interface: `handle(content, meta, listener) => unsubscribe`; `HandlerResolver`: `(key: string) => MessageHandler`
- Message routing via `routes.json` rules with glob matching, `isDM`/`participants` matching, template expansion (`${sender}`, `${channel}`), and file/agent destinations
- Channel gating (`gateUnmatched`) holds unrecognized channels in `inbox/` until the agent adds a routing rule
- Multi-participant conversations with fan-out to all agent participants; agent users tracked in the `users` table with `user_type: "agent"`
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
docker run -d -p 4200:4200 -v volute-data:/data -v volute-agents:/agents volute
```

Or with docker-compose: `docker compose up -d`. The container runs with `VOLUTE_ISOLATION=user` enabled, so each agent gets its own Linux user inside the container.

### Bare metal (Linux)

```sh
sudo bash install.sh
# or manually:
sudo volute setup --host 0.0.0.0
```

`volute setup` installs a system-level systemd service at `/etc/systemd/system/volute.service` with data at `/var/lib/volute`, agents at `/agents`, and user isolation enabled. Requires root. Uninstall with `volute setup uninstall [--force]`.

### User isolation

When `VOLUTE_ISOLATION=user` is set, `volute agent create` creates a Linux system user (`agent-<name>`, prefix configurable via `VOLUTE_USER_PREFIX`) and `chown`s the agent directory. Agent and connector processes are spawned with the agent's uid/gid, so agents can't access each other's files. This is a no-op when the env var is unset (default for local development).

On production deployments, `VOLUTE_AGENTS_DIR` separates agent directories from the Volute system directory. When set (e.g. `/agents`), `agentDir(name)` returns `$VOLUTE_AGENTS_DIR/<name>` instead of `$VOLUTE_HOME/agents/<name>`. This gives agents simpler, top-level home directories. Both `volute setup` (Linux) and Docker set this automatically.

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

## Commits and releases

We use [Conventional Commits](https://www.conventionalcommits.org/) and squash-merge PRs. Release-please reads the squash commit message (which comes from the PR title) to determine version bumps and changelog entries.

- **PR titles must be conventional commits** — e.g. `feat: add message routing`, `fix: handle empty batch`. A CI check enforces this.
- **Branch commits** don't need to follow the convention (they get squashed), but it's good practice.
- `feat:` → minor version bump, `fix:` → patch. `feat!:` or `fix!:` (with `!`) → major.
- Other prefixes (`docs:`, `chore:`, `refactor:`, `test:`, `ci:`, `perf:`) don't trigger a release.
