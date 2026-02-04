---
name: Molt Agent
description: This skill should be used when working in a molt agent project, understanding the agent architecture, working with variants, managing memory, or modifying agent behavior. Covers "create variant", "merge variant", "send to variant", "memory", "daily logs", "SOUL.md", "MEMORY.md", "agent server", "supervisor", "variant workflow", "molt CLI".
---

# Molt Agent Project

A molt agent project is a self-modifying AI agent powered by the Anthropic Claude Agent SDK. The agent runs as an HTTP/SSE server managed by a supervisor process.

## Architecture

- **`supervisor.ts`** — Process manager. Starts the agent server, handles crash recovery (3s delay), and orchestrates merge-restart flows.
- **`src/server.ts`** — HTTP server with SSE streaming. Loads home/SOUL.md, home/IDENTITY.md, home/USER.md, home/MEMORY.md into the system prompt, creates the agent, exposes endpoints.
- **`src/lib/agent.ts`** — Agent wrapper around the SDK `query()` function. Handles message streaming, compact boundary detection.

## CLI Commands

All agent operations are performed via the `molt` CLI.

| Command | Purpose |
|---------|---------|
| `molt start [--foreground] [--dev] [--port N]` | Start agent (daemonized by default) |
| `molt stop` | Stop the agent |
| `molt status [--port N]` | Check agent status (supervisor + server) |
| `molt logs [--follow] [-n N]` | Tail agent logs |
| `molt chat [--port N]` | Interactive TUI (default port 4100) |
| `molt fork <name> [--soul "..."] [--port N] [--json]` | Create variant (worktree + server) |
| `molt variants [--json]` | List variants with health status |
| `molt send --port <N> "<msg>"` | Send message to a variant, stream SSE response |
| `molt merge <name> [--summary "..."] [--justification "..."] [--memory "..."]` | Merge variant back, write orientation context, restart |

## Variant Workflow

1. `molt fork <name>` — create an isolated git worktree with its own server
2. Make code changes in the variant's worktree (directly or via `claude` in that directory)
3. Use `molt send --port <N> "<msg>"` to test the variant's behavior
4. `molt merge <name> --summary "..." --memory "..."` — merge back, supervisor restarts with orientation context
5. After restart, agent receives orientation with merge details from `.molt/merged.json`

## Memory System

Two-tier memory managed via direct file access:

- **`home/MEMORY.md`** — Long-term knowledge included in the system prompt.
- **`home/memory/YYYY-MM-DD.md`** — Daily log files for session context.
- On conversation compaction, the agent is prompted to update the daily log.
- Periodically consolidate old daily logs into MEMORY.md.

## Key Files

| File | Role |
|------|------|
| `home/SOUL.md` | Agent personality/instructions (system prompt) |
| `home/IDENTITY.md` | Agent identity (optional, included in system prompt) |
| `home/USER.md` | User context (optional, included in system prompt) |
| `home/MEMORY.md` | Long-term memory (appended to system prompt) |
| `home/memory/` | Daily log directory |
| `.molt/session.json` | SDK session ID for resume across restarts |
| `.molt/restart.json` | Signal from agent to supervisor (e.g. merge request) |
| `.molt/merged.json` | Post-merge context for agent orientation |
| `.molt/supervisor.pid` | Supervisor PID file |
| `.molt/variants.json` | Variant metadata (managed by CLI) |

## Development Mode

Run `molt start --dev` to enable hot-reload. This uses `tsx watch` to automatically restart the server when source files change.

## Development Notes

- All child process execution in MCP tools must be async (never `execFileSync`) to avoid blocking the event loop and dropping SSE connections.
- The supervisor is the only place `execFileSync` is used (for `molt merge`), since it doesn't serve SSE.
- Session persistence uses SDK session resume — the session ID is saved to `.molt/session.json`.
