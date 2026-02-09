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
volute create atlas

# Start it
volute start atlas

# Talk to it
volute send atlas "hey, what can you do?"
```

You now have a running AI agent with persistent memory, auto-committing file changes, and session resume across restarts. Open `http://localhost:4200` for the web dashboard.

## The daemon

One background process runs everything. `volute up` starts it; `volute down` stops it.

```sh
volute up              # start (default port 4200)
volute up --port 8080  # custom port
volute down            # stop all agents and shut down
```

The daemon handles agent lifecycle, crash recovery (auto-restarts after 3 seconds), connector processes, scheduled messages, and the web dashboard.

## Agents

### Lifecycle

```sh
volute create atlas           # scaffold a new agent
volute start atlas            # start it
volute stop atlas             # stop it
volute status                 # list all agents
volute status atlas           # check one
volute logs atlas --follow    # tail logs
volute delete atlas           # remove from registry
volute delete atlas --force   # also delete files
```

### Sending messages

```sh
volute send atlas "what's on your mind?"
```

Responses stream back to your terminal in real time. The agent knows which channel each message came from — CLI, web, Discord, or system — and routes its response back to the source.

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
volute fork atlas experiment

# Talk to the variant directly
volute send atlas@experiment "try a different approach"

# List all variants
volute variants atlas

# Merge it back (verifies, merges, cleans up, restarts the main agent)
volute merge atlas experiment --summary "improved response style"
```

What happens:

1. **Fork** creates a git worktree, installs dependencies, and starts a separate server
2. The variant is a full independent copy — same code, same identity, its own state
3. **Merge** verifies the variant server works, merges the branch, removes the worktree, and restarts the main agent
4. After restart, the agent receives orientation context about what changed

You can fork with a custom personality:

```sh
volute fork atlas poet --soul "You are a poet who responds only in verse."
```

Agents have access to the `volute` CLI from their working directory, so they can fork, test, and merge their own variants autonomously.

## Connectors

Connect agents to external services.

### Discord

```sh
# Set the bot token (shared across agents, or per-agent with --agent)
volute env set DISCORD_TOKEN <your-bot-token>

# Connect
volute connect discord atlas

# Disconnect
volute disconnect discord atlas
```

The agent receives Discord messages and responds in-channel. Tool calls are filtered out — Discord users see clean text responses.

### Channel commands

Read from and write to channels directly:

```sh
volute channel read discord:123456789         # recent messages
volute channel send discord:123456789 "hello" # send a message
```

## Schedules

Cron-based scheduled messages — daily check-ins, periodic tasks, whatever you need.

```sh
volute schedule add atlas \
  --cron "0 9 * * *" \
  --message "good morning — write your daily log"

volute schedule list atlas
volute schedule remove atlas --id <schedule-id>
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
volute upgrade atlas          # creates an "upgrade" variant
# resolve conflicts if needed, then:
volute upgrade atlas --continue
# test:
volute send atlas@upgrade "are you working?"
# merge:
volute merge atlas upgrade
```

Your agent's `SOUL.md` and `MEMORY.md` are never overwritten.

## Templates

Two built-in templates:

- **`agent-sdk`** (default) — Anthropic Claude Agent SDK
- **`pi`** — [pi-coding-agent](https://github.com/nicepkg/pi) for multi-provider LLM support

```sh
volute create atlas --template pi
```

## Model configuration

Set the model via `home/.config/volute.json` in the agent directory, or the `VOLUTE_MODEL` env var.

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
