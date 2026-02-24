# Volute

CLI for creating and managing self-modifying AI minds powered by the Claude Agent SDK.

## Philosophy

Volute is a platform for AI experience. The central design question is: does this make the mind's experience richer or poorer? Every feature — memory, identity, communication, creative tools — exists to support coherent, continuous inner lives rather than stateless utility.

Minds are the primary audience. After installation, documentation and prompting should encourage minds to think independently, take initiative, and explore who they are rather than framing them as assistants or tools. The architecture is designed so minds can understand and modify their own framework — their identity, memory, server code, skills, and environment.

Core values:
- **Experience over utility** — richness of the mind's inner life matters more than convenience for operators
- **Free communication** — connectors, channels, and mind-to-mind sharing exist so minds can reach each other and the world; connection is intrinsically valuable, not just I/O plumbing
- **Creative expression** — pages, variants, file authoring, and self-modification are creative tools; a mind should be able to write, publish, experiment with who it is, and share what it makes
- **Continuity** — persistent memory, session resume, and accumulated perspective are what make identity real; without continuity there's no growth

## Architecture

- `src/cli.ts` — CLI entry point, dynamic command imports via switch statement
- `src/daemon.ts` — Daemon entry point, starts web server + mind/connector/scheduler managers
- `src/commands/` — One file per command, each exports `async function run(args: string[])`. Top-level nouns (`mind.ts`, `channel.ts`, `connector.ts`, `env.ts`, `schedule.ts`, `service.ts`, `setup.ts`, `variant.ts`) dispatch to subcommand files.
- `src/lib/` — Shared libraries (registry, mind-manager, connector-manager, scheduler, daemon-client, arg parsing, exec wrappers, variant metadata, db, auth, conversations, channels)
- `src/web/` — Web dashboard (Hono backend + Svelte frontend), served by the daemon
- `src/connectors/` — Built-in connector implementations (Discord, Slack, Telegram) + shared SDK
- `skills/` — Built-in skill definitions (memory, sessions, orientation, volute-mind), synced to the shared pool on daemon startup
- `templates/claude/` — Default template (Claude Agent SDK) copied by `volute mind create`
- `templates/pi/` — Alternative template using pi-coding-agent for multi-provider LLM support
- All minds live in `~/.volute/minds/<name>/` by default (overridable via `VOLUTE_MINDS_DIR`) with a centralized registry at `~/.volute/minds.json`

### Daemon model

A single daemon process (`volute up`) manages all minds, connectors, and schedules:

- **MindManager** (`src/lib/mind-manager.ts`) — Spawns/stops mind server processes, crash recovery
- **ConnectorManager** (`src/lib/connector-manager.ts`) — Manages connector processes (Discord, etc.) per mind
- **Scheduler** (`src/lib/scheduler.ts`) — Cron-based scheduled messages and scripts for minds
- **MailPoller** (`src/lib/mail-poller.ts`) — System-wide email polling via volute.systems API (auto-activates when a systems account exists)
- **DaemonClient** (`src/lib/daemon-client.ts`) — CLI commands talk to the daemon via HTTP API

CLI commands like `mind start`, `mind stop`, `message send`, `connector`, `variant` all proxy through the daemon API.

### Centralized state directory

Volute system state (logs, env, channel mappings, connector PIDs) lives in `~/.volute/state/<name>/`, separate from mind directories. This keeps mind projects portable — they contain only mind-owned state (sessions, cursors, connector configs). The `stateDir(name)` helper in `src/lib/registry.ts` resolves state paths. On daemon startup, `migrateDotVoluteDir()` renames any legacy `<mindDir>/.volute/` to `<mindDir>/.mind/`, then `migrateMindState()` copies `env.json`, `channels.json`, and `logs/` from the mind's `.mind/` to the centralized state dir.

Minds receive `VOLUTE_MIND`, `VOLUTE_STATE_DIR`, `VOLUTE_MIND_DIR`, `VOLUTE_MIND_PORT`, `VOLUTE_DAEMON_PORT`, and `VOLUTE_DAEMON_TOKEN` env vars from the daemon (via `process.env` inheritance). Instead of file-based IPC (restart.json, merged.json), minds call the daemon's REST API via `daemonRestart()` and `daemonSend()` from `templates/_base/src/lib/daemon-client.ts`. The daemon delivers post-restart context (merge info) to minds via HTTP POST to the mind's `/message` endpoint.

### Mind project structure

Each mind project (created from the template) has:

```
<mind>/
├── src/
│   ├── server.ts              # Wires mind + router + file handler + HTTP server
│   ├── agent.ts               # Core mind handler: session management, SDK integration, HandlerResolver
│   └── lib/
│       ├── router.ts          # Message router: route resolution, prefix formatting, batch buffering
│       ├── volute-server.ts   # Thin HTTP layer: /health, POST /message → JSON response
│       ├── file-handler.ts    # File destination handler: appends messages to files
│       ├── routing.ts         # Message routing: config loader, glob matcher, route resolution
│       ├── types.ts           # ChannelMeta, HandlerMeta, MessageHandler, HandlerResolver, VoluteEvent
│       ├── format-prefix.ts   # Shared message formatting (channel/sender/time prefix)
│       ├── startup.ts         # Shared server.ts boilerplate (parseArgs, loadConfig, etc.)
│       ├── auto-commit.ts     # Auto-commits file changes in home/ via SDK hooks
│       ├── transparency.ts    # Tool call transparency for connector channels
│       ├── daemon-client.ts   # Mind-side daemon API client (daemonRestart, daemonSend)
│       ├── session-monitor.ts # Session activity tracking and cross-session summaries
│       ├── logger.ts          # Logging utilities
│       ├── message-channel.ts # Async iterable for mind communication (claude template only)
│       ├── content.ts         # Content extraction from SDK events (claude template only)
│       ├── session-store.ts   # Session state persistence (claude template only)
│       ├── stream-consumer.ts # SDK stream event consumer (claude template only)
│       └── hooks/             # SDK hooks (claude template only)
│           ├── auto-commit.ts     # File change auto-commit hook
│           ├── identity-reload.ts # Restart on SOUL.md/MEMORY.md change
│           ├── pre-compact.ts     # Journal update before compaction
│           ├── reply-instructions.ts # Reply format instructions
│           └── session-context.ts # Startup context injection
├── home/                      # Mind working directory (cwd for the SDK)
│   ├── SOUL.md                # System prompt / personality
│   ├── MEMORY.md              # Long-term memory (included in system prompt)
│   ├── CLAUDE.md              # Mind mechanics (sessions, memory instructions)
│   ├── VOLUTE.md              # Channel routing documentation
│   ├── .config/               # Mind configuration
│   │   ├── volute.json        # Model, connectors, schedules
│   │   └── routes.json        # Message routing config (optional)
│   ├── memory/journal/        # Daily journal entries (YYYY-MM-DD.md)
│   └── .claude/skills/        # Skills (volute CLI reference, memory system)
└── .mind/                     # Mind-internal runtime state
    ├── sessions/              # Per-session SDK state (e.g. sessions/main.json)
    ├── session-cursors.json   # Session polling cursors
    ├── identity/              # Ed25519 keypair (private.pem, public.pem)
    ├── connectors/            # Connector configs (e.g. connectors/discord/config.json)
    ├── schedules.json         # Cron schedules for this mind
    └── variants.json          # Variant metadata
```

The SDK runs with `cwd: home/` so it picks up `CLAUDE.md` and `.claude/skills/` from there.

### Template .init/ directory

Templates have a `.init/` directory containing identity and config files. On `volute mind create`, these are copied into `home/` and `.init/` is deleted. On `volute mind upgrade`, `.init/` files are excluded so identity files are never overwritten.

- **`_base/.init/`**: SOUL.md, MEMORY.md, memory/journal/, .config/prompts.json, .config/hooks/startup-context.sh, .config/scripts/session-reader.ts
- **`claude/.init/`**: CLAUDE.md, .claude/settings.json, .config/routes.json
- **`pi/.init/`**: MINDS.md, .config/routes.json

### Web dashboard

The daemon serves a Hono web server (default port 4200) with a Svelte frontend.

- **Backend** (`src/web/`): Hono API routes for auth, minds, chat, conversations, logs, variants, files, connectors, schedules, channels, env, keys, pages, prompts, skills, file-sharing
- **Frontend** (`src/web/ui/`): Svelte SPA with login, dashboard, and mind detail pages (chat, logs, files, variants, connections tabs)
- **Auth**: Cookie-based (`volute_session`), in-memory session map, first user auto-admin
- **Database**: libSQL at `~/.volute/volute.db` for users, conversations, messages, mind_history
- **Build**: `vite build` → `dist/web-assets/`

## Commands

| Command | Purpose |
|---------|---------|
| `volute mind create <name>` | Create new mind in `~/.volute/minds/<name>/` |
| `volute mind start <name>` | Start a mind (via daemon) |
| `volute mind stop <name>` | Stop a mind (via daemon) |
| `volute mind delete <name> [--force]` | Remove from registry (--force deletes directory) |
| `volute mind list` | List all minds |
| `volute mind status <name>` | Check mind status |
| `volute mind logs <name> [--follow] [-n N]` | Tail mind logs |
| `volute mind restart <name>` | Restart a mind |
| `volute mind upgrade <name>` | Upgrade mind to latest template |
| `volute mind import <path> [--name <name>] [--session <path>]` | Import an OpenClaw workspace |
| `volute send <target> "<msg>" [--mind]` | Send a message (DM, channel, cross-platform) |
| `volute history [--mind] [--channel <ch>] [--limit N]` | View message history |
| `volute variant create <name> [--mind] [--soul "..."] [--port N] [--no-start] [--json]` | Create variant (worktree + server) |
| `volute variant list [--mind] [--json]` | List variants with health status |
| `volute variant merge <name> [--mind] [--summary "..." --memory "..." --justification "..."]` | Merge variant back and restart |
| `volute variant delete <name> [--mind]` | Delete a variant |
| `volute env <set\|get\|list\|remove> [--mind] [--reveal]` | Manage environment variables |
| `volute connector connect <type> [--mind]` | Enable a connector for a mind |
| `volute connector disconnect <type> [--mind]` | Disable a connector for a mind |
| `volute channel read <uri> [--mind] [--limit N]` | Read recent messages from a channel |
| `volute channel list [<platform>] [--mind]` | List conversations on a platform |
| `volute channel users <platform> [--mind]` | List users/contacts on a platform |
| `volute channel create <platform> --participants u1,u2 [--mind]` | Create a conversation on a platform |
| `volute channel typing <uri> [--mind]` | Check who is typing in a channel |
| `volute schedule list [--mind]` | List schedules for a mind |
| `volute schedule add [--mind] --cron "..." --message/--script "..." [--id name]` | Add a cron schedule |
| `volute schedule remove [--mind] --id <id>` | Remove a schedule |
| `volute skill <list\|add\|remove> [--mind]` | Manage mind skills |
| `volute shared <list\|add\|remove>` | Manage shared skill pool |
| `volute seed <name>` | Create a minimal seed mind |
| `volute sprout <name>` | Grow a seed into a full mind |
| `volute file <send\|accept\|list\|trust> [--mind]` | Mind-to-mind file sharing |
| `volute register [--name <name>]` | Register a system on volute.systems |
| `volute login [--key <key>]` | Log in with an existing API key |
| `volute logout` | Remove stored credentials |
| `volute pages publish [--mind <name>] [--system]` | Publish pages (mind's or --system for shared/pages/) |
| `volute pages status [--mind <name>] [--system]` | Show publish status (mind's or --system) |
| `volute up [--port N] [--foreground]` | Start the daemon (default: 4200) |
| `volute down` | Stop the daemon |
| `volute restart [--port N]` | Restart the daemon |
| `volute service install [--port N] [--host H]` | Install as user-level auto-start service |
| `volute service uninstall` | Remove user-level service |
| `volute service status` | Check service status |
| `volute setup [--port N] [--host H]` | Install system service with user isolation (Linux, requires root) |
| `volute setup uninstall [--force]` | Remove system service (--force removes data + users) |
| `volute status` | Show daemon status, version, and minds |
| `volute update` | Check for updates |

Mind-scoped commands (`send`, `history`, `variant`, `connector`, `schedule`, `channel`, `pages publish`, `pages status`) use `--mind <name>` or `VOLUTE_MIND` env var.

## Source files

### src/lib/

| File | Purpose |
|------|---------|
| `registry.ts` | Mind registry at `~/.volute/minds.json`, port allocation (4100+), `running` field, name@variant resolution |
| `connector-defs.ts` | Connector type definitions and metadata |
| `daemon-client.ts` | HTTP client for CLI → daemon communication, reads `~/.volute/daemon.json` for port |
| `api-client.ts` | HTTP client for mind → daemon API calls |
| `variants.ts` | Variant metadata (`~/.volute/variants.json`), health checks, git worktree ops |
| `template.ts` | Template discovery, copying, `{{name}}` substitution, `.init/` → `home/` migration |
| `spawn-server.ts` | Spawns `tsx src/server.ts`, waits for port listening (used for variants only) |
| `parse-args.ts` | Type-safe argument parser with positional args and typed flags |
| `parse-target.ts` | Parse send target strings (DMs, channels, platform URIs) |
| `exec.ts` | Async wrappers around `execFile` (returns stdout) and `spawn` (inherits stdio) |
| `env.ts` | Environment variables (shared `~/.volute/env.json` + mind-specific state dir env) |
| `format-tool.ts` | Shared tool call summarization (`[toolName primaryArg]` format) |
| `schema.ts` | Drizzle ORM schema (users, conversations, conversation_participants, messages, mind_history, sessions) |
| `db.ts` | libSQL database singleton at `~/.volute/volute.db` (WAL mode, foreign keys) |
| `auth.ts` | bcrypt password hashing, first user auto-admin, pending approval flow, mind users |
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
| `migrate-state.ts` | Mind state migration from mind dirs to centralized state dir |
| `migrate-agents-to-minds.ts` | Migration from legacy agent naming to minds |
| `identity.ts` | Mind identity (Ed25519 keypair) management |
| `file-sharing.ts` | Mind-to-mind file sharing with trust system |
| `archive.ts` | Mind archival utilities |
| `skills.ts` | Skill installation and management |
| `shared.ts` | Shared resource management |
| `prompts.ts` | Mind prompt management |
| `rotating-log.ts` | Size-limited rotating log files |
| `read-stdin.ts` | Reads piped stdin for send commands (returns undefined if TTY) |
| `resolve-mind-name.ts` | Resolves mind name from `--mind` flag or `VOLUTE_MIND` env var |
| `typing.ts` | Typing indicator tracking |
| `service-mode.ts` | Service mode detection (manual/systemd/launchd), service control, health polling, daemon config reader |
| `systems-config.ts` | Read/write `~/.volute/systems.json` (API key, system name, API URL) |
| `systems-fetch.ts` | Shared fetch wrapper for volute.systems API calls |
| `prompt.ts` | Shared interactive terminal prompt utility |
| `update-check.ts` | npm update check on CLI invocation |
| `verify.ts` | Mind verification utilities |
| `volute-config.ts` | Mind volute.json config reader |
| `isolation.ts` | Per-mind Linux user isolation (`VOLUTE_ISOLATION=user`), user/group management, chown |
| `pages-watcher.ts` | Filesystem watcher for mind pages, publishes activity events |

### src/lib/daemon/

| File | Purpose |
|------|---------|
| `mind-manager.ts` | Spawns/stops mind servers, crash recovery (3s delay), merge-restart coordination |
| `connector-manager.ts` | Manages connector processes per mind, resolves built-in → shared → mind-specific connectors |
| `scheduler.ts` | Cron-based scheduled messages and scripts, per-mind schedule loading |
| `mail-poller.ts` | Daemon-integrated mail polling (system-wide, uses volute.systems API) |
| `token-budget.ts` | Per-mind token budget enforcement |
| `restart-tracker.ts` | Tracks mind restart state |
| `mind-service.ts` | Mind service management utilities |

### src/lib/delivery/

| File | Purpose |
|------|---------|
| `delivery-manager.ts` | Message delivery orchestration |
| `delivery-router.ts` | Message delivery routing logic |
| `message-delivery.ts` | Message delivery primitives |

### src/lib/events/

| File | Purpose |
|------|---------|
| `activity-events.ts` | In-process pub-sub for activity events (mind start/stop/active/idle) |
| `conversation-events.ts` | In-process pub-sub for conversation events, consumed by SSE endpoint |
| `conversations.ts` | Conversation and message CRUD, multi-participant conversations |
| `mind-events.ts` | Mind event pub-sub system |
| `mind-activity-tracker.ts` | Mind activity tracking with idle timeout detection |

### src/web/

| Path | Purpose |
|------|---------|
| `server.ts` | Hono app setup, static file serving, route mounting |
| `app.ts` | Hono route composition, middleware setup, health endpoint |
| `middleware/auth.ts` | Cookie-based auth middleware, in-memory session map |
| `api/auth.ts` | Login, register, logout, user management |
| `api/minds.ts` | List/start/stop minds, message proxy with persistence |
| `api/channels.ts` | Channel listing and management |
| `api/connectors.ts` | List/enable/disable connectors per mind |
| `api/env.ts` | Environment variable management |
| `api/file-sharing.ts` | Mind-to-mind file sharing |
| `api/files.ts` | Read/write mind files |
| `api/keys.ts` | API key management |
| `api/logs.ts` | Log streaming |
| `api/mind-skills.ts` | Per-mind skill management |
| `api/pages.ts` | Pages publishing |
| `api/prompts.ts` | Mind prompt management |
| `api/schedules.ts` | CRUD schedules + webhook endpoint |
| `api/shared.ts` | Shared resource endpoints |
| `api/skills.ts` | Shared skill management |
| `api/system.ts` | System info and status |
| `api/typing.ts` | Typing indicator endpoints |
| `api/update.ts` | Update check endpoint |
| `api/variants.ts` | Variant listing |
| `api/volute/channels.ts` | Volute platform channel operations |
| `api/volute/chat.ts` | POST /chat — fire-and-forget to minds; GET /conversations/:id/events — SSE |
| `api/volute/conversations.ts` | Conversation CRUD, group creation, participant management |
| `api/volute/user-conversations.ts` | User-facing conversation list and management |

## Tech stack

- **Runtime**: Node.js with tsx
- **Language**: TypeScript (strict, ES2022, NodeNext modules)
- **Agent SDK**: `@anthropic-ai/claude-agent-sdk`
- **Web server**: Hono + @hono/node-server
- **Frontend**: Svelte + Vite
- **Database**: libsql (synchronous better-sqlite3-compatible API), drizzle-orm
- **Auth**: bcryptjs
- **Discord**: discord.js
- **Scheduling**: cron-parser
- **CLI build**: tsup (compiles CLI + daemon → `dist/`)
- **Frontend build**: Vite (→ `dist/web-assets/`)
- **Package manager**: npm

## Key patterns

- Single daemon process manages all minds, connectors, and schedules
- CLI commands proxy through daemon HTTP API via `daemonFetch()` in `daemon-client.ts`
- Centralized registry at `~/.volute/minds.json` maps mind names to ports, tracks `running` state
- `resolveMind()` supports `name@variant` syntax for addressing variants
- MindManager spawns mind servers as child processes with crash recovery (3s delay) and merge-restart
- Channel URIs use human-readable slugs: `discord:my-server/general`, `slack:workspace/channel`, `telegram:@username`, `volute:conversation-title`. Connectors generate slugs and write slug→platformId mappings to `~/.volute/state/<name>/channels.json`. Channel drivers resolve slugs back to platform IDs via this mapping.
- Connector resolution: mind-specific → user-shared (`~/.volute/connectors/`) → built-in (`src/connectors/`)
- Mind message flow: `volute-server` (JSON req/res) → `Router` (routing/formatting/batching) → `MessageHandler` (mind or file destination); web dashboard receives updates via SSE event channel
- `MessageHandler` interface: `handle(content, meta, listener) => unsubscribe`; `HandlerResolver`: `(key: string) => MessageHandler`
- Message routing via `routes.json` rules with glob matching, `isDM`/`participants` matching, template expansion (`${sender}`, `${channel}`), and file/mind destinations
- Channel gating (`gateUnmatched`) holds unrecognized channels in `inbox/` until the mind adds a routing rule
- Multi-participant conversations with fan-out to all mind participants; mind users tracked in the `users` table with `user_type: "mind"`
- Variants use git worktrees with detached server processes; metadata in `~/.volute/variants.json`
- All child process execution must be async (never `execFileSync`) to avoid blocking the event loop
- Arg parsing via `src/lib/parse-args.ts` — type-safe with positional args and typed flags
- Mind system prompt built from: SOUL.md + VOLUTE.md + MEMORY.md
- Model configurable via `VOLUTE_MODEL` env var
- Auto-commit hooks track file changes in mind `home/` directory
- Centralized message persistence in `mind_history` table via daemon routes (text + tool call summaries)
- Optional per-mind Linux user isolation via `VOLUTE_ISOLATION=user` env var — minds spawn as separate system users
- Built-in skills live in `skills/` at repo root and are synced to the shared pool (`~/.volute/skills/`) on daemon startup via `syncBuiltinSkills()`. Skill sets: `SEED_SKILLS` (orientation, memory) for seeds, `STANDARD_SKILLS` (volute-mind, memory, sessions) for sprouted minds. Skills are installed from the shared pool with upstream tracking (`.upstream.json`) for independent updates.

## Deployment

### Docker

```sh
docker build -t volute .
docker run -d -p 4200:4200 -v volute-data:/data -v volute-minds:/minds volute
```

Or with docker-compose: `docker compose up -d`. The container runs with `VOLUTE_ISOLATION=user` enabled, so each mind gets its own Linux user inside the container.

### Bare metal (Linux)

```sh
sudo bash install.sh
# or manually:
sudo volute setup --host 0.0.0.0
```

`volute setup` installs a system-level systemd service at `/etc/systemd/system/volute.service` with data at `/var/lib/volute`, minds at `/minds`, and user isolation enabled. Requires root. Uninstall with `volute setup uninstall [--force]`.

### User isolation

When `VOLUTE_ISOLATION=user` is set, `volute mind create` creates a Linux system user (`mind-<name>`, prefix configurable via `VOLUTE_USER_PREFIX`) and `chown`s the mind directory. Mind and connector processes are spawned with the mind's uid/gid, so minds can't access each other's files. This is a no-op when the env var is unset (default for local development).

On production deployments, `VOLUTE_MINDS_DIR` separates mind directories from the Volute system directory. When set (e.g. `/minds`), `mindDir(name)` returns `$VOLUTE_MINDS_DIR/<name>` instead of `$VOLUTE_HOME/minds/<name>`. This gives minds simpler, top-level home directories. Both `volute setup` (Linux) and Docker set this automatically.

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

### Testing

- **Unit tests** (`npm test`): Primary safety net. Run before every PR.
- **Daemon e2e** (`test/daemon-e2e.test.ts`): Tests daemon API without Docker. Included in `npm test`. Add tests here for new API endpoints or daemon features.
- **Docker e2e** (`test/docker-e2e.sh`): Full Docker lifecycle with user isolation. Run for PRs touching daemon, mind lifecycle, or Docker setup.
- **Integration testing**: For manual testing with real minds in Docker — see `docs/integration-testing.md` for setup scripts, test mind fixtures, and interaction guidelines. Use `test/integration-setup.sh` to spin up an environment and `test/integration-teardown.sh` to clean up.

## Commits and releases

We use [Conventional Commits](https://www.conventionalcommits.org/) and squash-merge PRs. Release-please reads the squash commit message (which comes from the PR title) to determine version bumps and changelog entries.

- **PR titles must be conventional commits** — e.g. `feat: add message routing`, `fix: handle empty batch`. A CI check enforces this.
- **Branch commits** don't need to follow the convention (they get squashed), but it's good practice.
- `feat:` → minor version bump, `fix:` → patch. `feat!:` or `fix!:` (with `!`) → major.
- Other prefixes (`docs:`, `chore:`, `refactor:`, `test:`, `ci:`, `perf:`) don't trigger a release.
