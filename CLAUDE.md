# Molt

CLI framework for creating and managing self-modifying AI agents powered by the Anthropic Claude Agent SDK.

## Architecture

- `src/` - CLI source (entry: `src/cli.ts`, commands in `src/commands/`)
- `src/lib/registry.ts` - Central agent registry (`~/.molt/agents.json`, name/port/dir resolution)
- `src/lib/supervisor.ts` - Supervisor logic (spawn server, crash recovery, merge-restart)
- `templates/anthropic/` - Template copied by `molt create` for new agent projects
- All agents live in `~/.molt/agents/<name>/` with a centralized registry
- Each agent project has: HTTP/SSE server, home/ (SOUL.md, MEMORY.md, IDENTITY.md, USER.md)

## Commands

All commands take the agent name as a positional argument.

| Command | Purpose |
|---------|---------|
| `molt create <name>` | Create new agent in `~/.molt/agents/<name>/` |
| `molt start <name> [--foreground] [--dev]` | Start agent (daemonized by default) |
| `molt stop <name>` | Stop the agent |
| `molt status [<name>]` | Check agent status, or list all agents |
| `molt logs <name> [--follow] [-n N]` | Tail agent logs |
| `molt chat <name>` | Interactive TUI |
| `molt send <name> "<msg>"` | Send message, stream SSE response |
| `molt memory <name> "<context>"` | Send context for the agent to remember |
| `molt fork <name> <variant> [--soul "..."] [--port N] [--json]` | Create variant (worktree + server) |
| `molt variants <name> [--json]` | List variants with health status |
| `molt merge <name> <variant>` | Merge variant back and restart |
| `molt import <path> [--name <name>]` | Import an OpenClaw workspace |

## Tech stack

- **Runtime**: Node.js with tsx (esbuild-based TypeScript execution)
- **Language**: TypeScript (strict, ES2022, NodeNext modules)
- **TUI**: React/Ink (`src/components/`)
- **Agent SDK**: `@anthropic-ai/claude-agent-sdk`
- **CLI build**: tsup (compiles CLI → `dist/cli.js`)
- **Package manager**: npm

## Key patterns

- Commands are dynamically imported in `src/cli.ts` and export `async function run(args: string[])`
- Agent servers use HTTP + Server-Sent Events for communication
- Centralized registry at `~/.molt/agents.json` maps agent names to ports
- Supervisor runs in the CLI process (not in agent projects), handles crash recovery and merge-restart
- Variants use git worktrees with detached server processes
- Variant metadata stored in `<agentDir>/.molt/variants.json`
- All child process execution in MCP tools must be async (never use `execFileSync`) to avoid blocking the event loop and dropping SSE connections

## Development

```sh
npm install              # install dependencies
npm run dev              # run CLI in dev mode (via tsx)
npm run build            # build CLI to dist/
molt create test-agent && molt start test-agent  # test end-to-end
```

The CLI is installed globally via `npm link` (requires `npm run build` first) or run in dev mode via `tsx src/cli.ts`.
