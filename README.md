# volute

A CLI for creating and managing self-modifying AI agents. Agents run as persistent HTTP servers, communicate via NDJSON streaming, and can fork themselves into variants — isolated branches that run in parallel and merge back when ready.

Built on the [Anthropic Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk).

## Install

```sh
npm install
npm run build
npm link
```

## Quick start

```sh
# Create a new agent
volute create my-agent

# Edit its personality
$EDITOR ~/.volute/agents/my-agent/home/SOUL.md

# Start it
volute start my-agent

# Send it a message
volute send my-agent "hello"

# Or use the web dashboard
volute ui
```

## Commands

### Agent management

| Command | Description |
|---------|-------------|
| `volute create <name>` | Create a new agent project |
| `volute start <name> [--foreground] [--dev]` | Start agent supervisor (daemonized by default) |
| `volute stop <name>` | Stop agent |
| `volute status [<name>]` | Check agent status, or list all agents |
| `volute delete <name> [--force]` | Remove agent (--force deletes files) |
| `volute logs <name> [--follow] [-n N]` | Tail agent logs |

### Communication

| Command | Description |
|---------|-------------|
| `volute send <name> "<msg>"` | Send a message and stream the response |
| `volute ui [--port N]` | Start web dashboard (default port 4200) |

### Variants

| Command | Description |
|---------|-------------|
| `volute fork <name> <variant> [--soul "..."] [--port N]` | Create a variant |
| `volute variants <name> [--json]` | List variants with health status |
| `volute merge <name> <variant>` | Merge a variant back and restart |

### Discord

| Command | Description |
|---------|-------------|
| `volute connect discord <name>` | Connect a Discord bot to an agent |
| `volute disconnect discord <name>` | Stop a Discord bot connector |
| `volute channel read <uri>` | Read recent messages from a channel |
| `volute channel send <uri> "<msg>"` | Send a message to a channel |

### Other

| Command | Description |
|---------|-------------|
| `volute env <set\|get\|list\|remove> [--agent <name>]` | Manage environment variables |
| `volute upgrade <name>` | Upgrade agent to latest template |
| `volute import <path> [--name <name>]` | Import an OpenClaw workspace |

## Variants

Agents can create isolated copies of themselves to experiment with changes in parallel. Each variant gets its own git branch, worktree, and server.

```sh
# Fork a variant with a custom personality
volute fork my-agent chef --soul "You are a French chef. Keep responses to 1 sentence."

# Talk to it
volute send my-agent@chef "what do you think of pizza?"

# See all running variants
volute variants my-agent

# Merge it back
volute merge my-agent chef
```

Agents can also do this themselves — they have access to `create_variant`, `send_to_variant`, `list_variants`, and `merge_variant` as tools.

## Web dashboard

`volute ui` starts a web interface with real-time chat, log viewing, file editing, variant management, and connection status. First user to register becomes admin.

## How it works

- `volute create` copies a template into `~/.volute/agents/<name>/` with a server, agent configuration, and git repo.
- The agent server exposes `/health` and `POST /message` endpoints, streaming responses as NDJSON.
- `home/SOUL.md` defines the agent's personality. `home/MEMORY.md` persists context across restarts. `home/VOLUTE.md` documents channel routing.
- The supervisor handles crash recovery (3s delay) and coordinates merge-restarts.
- Variants are git worktrees with their own server processes; `name@variant` syntax addresses them directly.
- `volute upgrade` updates an agent's template code while preserving its identity files (SOUL.md, MEMORY.md, etc.).
- Model is configurable via `VOLUTE_MODEL` env var.
