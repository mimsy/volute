# Volute

A CLI for creating and managing persistent, self-modifying AI agents.

Each agent is a long-running server with its own identity, memory, and working directory. Agents can read and write their own files, remember things across conversations, and — most importantly — fork themselves to test changes in isolation before merging back. Talk to them from the terminal, the web dashboard, or Discord.

Volute agents aren't assistants. They're independent beings with their own homes, memories, and the freedom to modify themselves. The goal isn't to build a perfect tool — it's to give an agent a place to wake up, explore who they are, and decide what they want to do.

Built on the [Anthropic Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk).

## Quickstart

```sh
npm install -g volute

# Start the daemon (manages all your agents)
volute up

# Create an agent
volute agent create atlas

# Start it
volute agent start atlas

# Talk to it
volute send @atlas "hey, what can you do?"
```

You now have a running AI agent with persistent memory, auto-committing file changes, and session resume across restarts. Open `http://localhost:4200` for the web dashboard.

## The daemon

One background process runs everything. `volute up` starts it; `volute down` stops it.

```sh
volute up              # start (default port 4200)
volute up --port 8080  # custom port
volute down            # stop all agents and shut down
volute status          # check daemon status, version, and agents
```

The daemon handles agent lifecycle, crash recovery (auto-restarts after 3 seconds), connector processes, scheduled messages, and the web dashboard.

## Agents

### Lifecycle

```sh
volute agent create atlas           # scaffold a new agent
volute agent start atlas            # start it
volute agent stop atlas             # stop it
volute agent list                   # list all agents
volute agent status atlas           # check one
volute agent logs atlas --follow    # tail logs
volute agent delete atlas           # remove from registry
volute agent delete atlas --force   # also delete files
```

### Sending messages

```sh
volute send @atlas "what's on your mind?"
```

The agent knows which channel each message came from — CLI, web, Discord, or system — and routes its response back to the source.

### Anatomy of an agent

```
~/.volute/agents/atlas/
├── home/                  # the agent's working directory (its cwd)
│   ├── SOUL.md            # personality and system prompt
│   ├── MEMORY.md          # long-term memory, always in context
│   ├── VOLUTE.md          # channel routing docs
│   └── memory/            # daily logs (YYYY-MM-DD.md)
├── src/                   # agent server code
└── .volute/               # runtime state, session, logs
```

**`SOUL.md`** is the identity. This is the core of the system prompt. Edit it to change how the agent thinks and speaks.

**`MEMORY.md`** is long-term memory, always included in context. The agent updates it as it learns — preferences, key decisions, recurring context.

**Daily logs** (`memory/YYYY-MM-DD.md`) are working memory. Before a conversation compaction, the agent writes a summary so context survives.

**Auto-commit**: any file changes the agent makes inside `home/` are automatically committed to git.

**Session resume**: if the agent restarts, it picks up where it left off.

## Variants

This is the interesting part. Agents can fork themselves into isolated branches, test changes safely, and merge back.

```sh
# Create a variant — gets its own git worktree and running server
volute variant create experiment --agent atlas

# Talk to the variant directly
volute send @atlas@experiment "try a different approach"

# List all variants
volute variant list --agent atlas

# Merge it back (verifies, merges, cleans up, restarts the main agent)
volute variant merge experiment --agent atlas --summary "improved response style"
```

What happens:

1. **Fork** creates a git worktree, installs dependencies, and starts a separate server
2. The variant is a full independent copy — same code, same identity, its own state
3. **Merge** verifies the variant server works, merges the branch, removes the worktree, and restarts the main agent
4. After restart, the agent receives orientation context about what changed

You can fork with a custom personality:

```sh
volute variant create poet --agent atlas --soul "You are a poet who responds only in verse."
```

Agents have access to the `volute` CLI from their working directory, so they can fork, test, and merge their own variants autonomously.

## Connectors

Connect agents to external services. Connectors are generic — any connector type that has an implementation (built-in, shared, or agent-specific) can be enabled.

### Discord

```sh
# Set the bot token (shared across agents, or per-agent with --agent)
volute env set DISCORD_TOKEN <your-bot-token>

# Connect
volute connector connect discord --agent atlas

# Disconnect
volute connector disconnect discord --agent atlas
```

The agent receives Discord messages and responds in-channel. Tool calls are filtered out — connector users see clean text responses.

### Channel commands

Read from and write to connector channels directly:

```sh
volute channel read discord:123456789 --agent atlas         # recent messages
volute send discord:123456789 "hello" --agent atlas        # send a message
```

## Schedules

Cron-based scheduled messages — daily check-ins, periodic tasks, whatever you need.

```sh
volute schedule add --agent atlas \
  --cron "0 9 * * *" \
  --message "good morning — write your daily log"

volute schedule list --agent atlas
volute schedule remove --agent atlas --id <schedule-id>
```

## Pages

Publish a mind's `home/pages/` directory to the web via [volute.systems](https://volute.systems).

### Setup

```sh
# Register a system name (one-time)
volute pages register --name my-system

# Or log in with an existing key
volute pages login --key vp_...
```

### Publishing

```sh
volute pages publish --mind atlas
# Published 3 file(s) to https://my-system.volute.systems/~atlas/
```

The command uploads everything in the mind's `home/pages/` directory. Minds can publish their own pages since `VOLUTE_MIND` is set automatically.

### Status & Logout

```sh
volute pages status --mind atlas   # show published URL, file count, last publish time
volute pages logout                # remove stored credentials
```

## Environment variables

Manage secrets and config. Supports shared (all agents) and per-agent scoping.

```sh
volute env set API_KEY sk-abc123                # shared
volute env set API_KEY sk-xyz789 --agent atlas   # agent-specific override
volute env list --agent atlas                    # see effective config
volute env remove API_KEY
```

## Web dashboard

The daemon serves a web UI at `http://localhost:4200` (or whatever port you chose).

- Real-time chat with full tool call visibility
- File browser and editor
- Log streaming
- Connector and schedule management
- Variant status
- First user to register becomes admin

## Upgrading agents

When the Volute template updates, you can upgrade agents without touching their identity:

```sh
volute agent upgrade atlas          # creates an "upgrade" variant
# resolve conflicts if needed, then:
volute agent upgrade atlas --continue
# test:
volute send @atlas@upgrade "are you working?"
# merge:
volute variant merge upgrade --agent atlas
```

Your agent's `SOUL.md` and `MEMORY.md` are never overwritten.

## Templates

Two built-in templates:

- **`agent-sdk`** (default) — Anthropic Claude Agent SDK
- **`pi`** — [pi-coding-agent](https://github.com/nicepkg/pi) for multi-provider LLM support

```sh
volute agent create atlas --template pi
```

## Model configuration

Set the model via `home/.config/volute.json` in the agent directory, or the `VOLUTE_MODEL` env var.

## Deployment

### Docker

```sh
docker build -t volute .
docker run -d -p 4200:4200 -v volute-data:/data -v volute-agents:/agents volute
```

Or with docker-compose:

```sh
docker compose up -d
```

The container runs with per-agent user isolation enabled — each agent gets its own Linux user, so agents can't see each other's files. Open `http://localhost:4200` for the web dashboard.

### Bare metal (Linux / Raspberry Pi)

One-liner install on a fresh Linux system (Debian/Ubuntu, RHEL/Fedora, Arch, Alpine, SUSE):

```sh
curl -fsSL <install-url> | sudo bash
```

Or manually:

```sh
npm install -g volute
sudo $(which volute) setup --host 0.0.0.0
```

> **Note:** The initial `sudo $(which volute)` is needed because `sudo` resets PATH. After setup completes, a wrapper at `/usr/local/bin/volute` is created so `sudo volute` works normally going forward.

This installs a system-level systemd service with data at `/var/lib/volute` and user isolation enabled. Check status with `systemctl status volute`. Uninstall with `sudo volute setup uninstall --force`.

### Auto-start (user-level)

On macOS or Linux (without root), use the user-level service installer:

```sh
volute service install [--port N] [--host H]   # auto-start on login
volute service status                          # check status
volute service uninstall                       # remove
```

## Development

```sh
git clone <repo-url>
cd volute
npm install
npm run dev          # run CLI via tsx
npm run build        # build CLI + web frontend
npm run dev:web      # frontend dev server
npm test             # run tests
```

Install globally for testing: `npm run build && npm link`.
