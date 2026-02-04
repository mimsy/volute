# molt

A CLI for creating and managing self-modifying AI agents. Agents run as HTTP servers, communicate via Server-Sent Events, and can fork themselves into variants — isolated branches that run in parallel and merge back when ready.

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
molt create my-agent
cd my-agent

# Edit home/SOUL.md to define its personality, then start it
molt start

# Chat with it
molt chat
```

## Variants

Agents can create isolated copies of themselves to experiment with changes in parallel. Each variant gets its own git branch, worktree, and server.

```sh
# Fork a variant with a custom personality
molt fork chef --soul "You are a French chef. Keep responses to 1 sentence."

# Talk to it
molt send --port 54321 "what do you think of pizza?"

# See all running variants
molt variants

# Merge it back
molt merge chef
```

Agents can also do this themselves — they have access to `create_variant`, `send_to_variant`, `list_variants`, and `merge_variant` as tools.

## Commands

| Command | Description |
|---------|-------------|
| `molt create <name>` | Create a new agent project |
| `molt start` | Start the agent supervisor |
| `molt chat [--port N]` | Interactive terminal UI |
| `molt status [--port N]` | Health check |
| `molt fork <name> [--soul "..."] [--port N] [--json]` | Create a variant |
| `molt variants [--json]` | List variants |
| `molt send --port <N> "<msg>"` | Send a message and print the response |
| `molt merge <name>` | Merge a variant back and restart |

## How it works

- `molt create` copies a template into a new directory with a supervisor, HTTP server, and agent configuration.
- The agent server exposes `/health`, `/events` (SSE), and `/message` (POST) endpoints.
- `home/SOUL.md` defines the agent's personality and instructions. `home/MEMORY.md` persists context across restarts.
- Variants are git worktrees with their own server processes. The supervisor handles crash recovery and merge-restart coordination.
