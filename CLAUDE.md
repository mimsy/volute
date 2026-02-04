# Molt

CLI for creating and managing self-modifying AI agents powered by the Anthropic Claude Agent SDK.

## Architecture

- `src/cli.ts` - Entry point, dynamic command imports via switch statement
- `src/commands/` - One file per command, each exports `async function run(args: string[])`
- `src/lib/` - Shared libraries (registry, supervisor, arg parsing, exec wrappers, variant metadata)
- `src/components/` - React/Ink TUI components for `molt chat`
- `templates/agent-sdk/` - Default template (Claude Agent SDK) copied by `molt create`
- `templates/pi/` - Alternative template using pi-coding-agent for multi-provider LLM support
- All agents live in `~/.molt/agents/<name>/` with a centralized registry at `~/.molt/agents.json`

### Agent project structure

Each agent project (created from the template) has:

```
<agent>/
├── src/server.ts          # HTTP/SSE server, loads system prompt, creates SDK agent
├── src/lib/               # Agent SDK wrapper, logger, message channel, types
├── home/                  # Agent working directory (cwd for the SDK)
│   ├── SOUL.md            # System prompt / personality
│   ├── MEMORY.md          # Long-term memory (included in system prompt)
│   ├── CLAUDE.md          # Agent mechanics (sessions, memory instructions)
│   ├── IDENTITY.md        # Agent identity (optional)
│   ├── USER.md            # User context (optional)
│   ├── memory/            # Daily logs (YYYY-MM-DD.md)
│   └── .claude/skills/    # Skills (molt CLI reference, memory system)
└── .molt/                 # Runtime state (session.json, variants.json, PIDs)
```

The SDK runs with `cwd: home/` so it picks up `CLAUDE.md` and `.claude/skills/` from there.

## Commands

| Command | Purpose |
|---------|---------|
| `molt create <name>` | Create new agent in `~/.molt/agents/<name>/` |
| `molt start <name> [--foreground] [--dev]` | Start agent (daemonized by default) |
| `molt stop <name>` | Stop the agent |
| `molt delete <name> [--force]` | Remove from registry (--force deletes directory) |
| `molt status [<name>]` | Check agent status, or list all agents |
| `molt logs <name> [--follow] [-n N]` | Tail agent logs |
| `molt chat <name>` | Interactive TUI |
| `molt send <name> "<msg>"` | Send message, stream SSE response |
| `molt memory <name> "<context>"` | Send context for the agent to remember |
| `molt fork <name> <variant> [--soul "..."] [--port N] [--json]` | Create variant (worktree + server) |
| `molt variants <name> [--json]` | List variants with health status |
| `molt merge <name> <variant> [--summary "..." --memory "..."]` | Merge variant back and restart |
| `molt env <set\|get\|list\|remove> [--agent <name>]` | Manage environment variables |
| `molt import <path> [--name <name>] [--session <path>]` | Import an OpenClaw workspace |

## Tech stack

- **Runtime**: Node.js with tsx
- **Language**: TypeScript (strict, ES2022, NodeNext modules)
- **TUI**: React/Ink (`src/components/`)
- **Agent SDK**: `@anthropic-ai/claude-agent-sdk`
- **CLI build**: tsup (compiles CLI → `dist/cli.js`)
- **Package manager**: npm

## Key patterns

- Centralized registry at `~/.molt/agents.json` maps agent names to ports
- Supervisor runs in the CLI process, spawns the agent server, handles crash recovery (3s delay) and merge-restart
- Agent servers use HTTP + SSE for communication (`/health`, `/events`, `/message`, `/command`)
- Variants use git worktrees with detached server processes; metadata in `<agentDir>/.molt/variants.json`
- All child process execution must be async (never `execFileSync`) to avoid blocking the event loop and dropping SSE connections
- Arg parsing via `src/lib/parse-args.ts` — type-safe with positional args and typed flags

## Development

```sh
npm install              # install dependencies
npm run dev              # run CLI in dev mode (via tsx)
npm run build            # build CLI to dist/
npm test                 # run tests
molt create test-agent && molt start test-agent  # test end-to-end
```

The CLI is installed globally via `npm link` (requires `npm run build` first) or run in dev mode via `tsx src/cli.ts`.
