---
name: Molt Agent
description: This skill should be used when working in a molt agent project, understanding the agent's MCP tools, modifying agent behavior, working with variants, managing memory, or understanding the supervisor/server architecture. Covers "create variant", "merge variant", "send to variant", "memory tools", "daily logs", "SOUL.md", "MEMORY.md", "agent server", "supervisor", "Claude Code session", "agent tools", "MCP tools".
---

# Molt Agent Project

A molt agent project is a self-modifying AI agent powered by the Anthropic Claude Agent SDK. The agent runs as an HTTP/SSE server managed by a supervisor process.

## Architecture

- **`supervisor.ts`** — Process manager. Starts the agent server, handles crash recovery (3s delay), and orchestrates merge-restart flows.
- **`src/server.ts`** — HTTP server with SSE streaming. Loads home/SOUL.md, home/IDENTITY.md, home/USER.md, home/MEMORY.md into the system prompt, creates the agent, exposes endpoints.
- **`src/lib/agent.ts`** — Agent wrapper around the SDK `query()` function. Handles message streaming, compact boundary detection.
- **`src/lib/self-modify-tools.ts`** — MCP tools for variants and Claude Code sessions.
- **`src/lib/memory-tools.ts`** — MCP tools for memory management.

## MCP Tools Available to the Agent

### Variant Tools (self-modify)

| Tool | Purpose |
|------|---------|
| `create_variant` | Create a git worktree + server. Optionally set a custom soul. Returns variant info including port. |
| `list_variants` | List all active variants with ports, status, branches. |
| `send_to_variant` | Send a message to a variant server. Variant maintains conversation history. |
| `merge_variant` | Merge variant back into main branch. Exits process; supervisor handles merge and restart. |
| `update_worktree_soul` | Update SOUL.md in a variant's worktree. |

### Claude Code Session Tools (self-modify)

| Tool | Purpose |
|------|---------|
| `start_claude_code_session` | Start a coding assistant in a variant's worktree. Returns session_id. |
| `send_to_claude_code_session` | Send a message to a Claude Code session and get the response. |
| `end_claude_code_session` | End a Claude Code session. |

### Memory Tools

| Tool | Purpose |
|------|---------|
| `read_memory` | Read MEMORY.md (long-term memory). |
| `write_memory` | Overwrite MEMORY.md for reorganizing/consolidating. |
| `read_daily_log` | Read a daily log file (defaults to today). |
| `write_daily_log` | Write/overwrite today's daily log. |
| `consolidate_memory` | Read old daily logs for review and promotion to long-term memory. |

## Memory System

Two-tier memory with agent ownership:

- **`home/MEMORY.md`** — Long-term knowledge included in the system prompt. Manage via `write_memory`.
- **`home/memory/YYYY-MM-DD.md`** — Daily log files for session context. Manage via `write_daily_log`.
- On conversation compaction, the agent is prompted to update the daily log.
- Periodically consolidate old daily logs into MEMORY.md via `consolidate_memory`.

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

## Server Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Health check — returns `{status, name, version}` |
| `/events` | GET | SSE stream of agent messages |
| `/message` | POST | Send message to agent — `{content, source?}` |
| `/command` | POST | Command API — `{type: "update-memory", context: "..."}` |

## Variant Workflow

1. `create_variant` — create isolated git worktree + server
2. Use `start_claude_code_session` to make code changes, or `send_to_variant` to test behavior
3. Use `update_worktree_soul` to iterate on personality (no teardown needed)
4. `merge_variant` — merge back, supervisor restarts with merge context
5. After restart, agent receives orientation with merge details and updates memory

## Development Mode

Run `molt start --dev` to enable hot-reload. This uses `tsx watch` to automatically restart the server when source files change. SSE clients will disconnect on each reload — reconnect via `molt chat`.

## Development Notes

- All child process execution in MCP tools must be async (never `execFileSync`) to avoid blocking the event loop and dropping SSE connections.
- The supervisor is the only place `execFileSync` is used (for `molt merge`), since it doesn't serve SSE.
- Agent tools call the `molt` CLI via `spawn()` for fork/merge/send operations.
- Session persistence uses SDK session resume — the session ID is saved to `.molt/session.json`.
