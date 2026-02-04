# Molt

CLI framework for creating and managing self-modifying AI agents powered by the Anthropic Claude Agent SDK.

## Architecture

- `src/` - CLI source (entry: `src/cli.ts`, commands in `src/commands/`)
- `templates/anthropic/` - Template copied by `molt create` for new agent projects
- Each agent project has: supervisor, HTTP/SSE server, home/ (SOUL.md, MEMORY.md, IDENTITY.md, USER.md)

## Commands

| Command | Purpose |
|---------|---------|
| `molt create <name>` | Create new agent project from template |
| `molt start` | Start supervisor (run from agent dir) |
| `molt chat [--port N]` | Interactive TUI (default port 4100) |
| `molt status [--port N]` | Health check |
| `molt fork <name> [--soul "..."] [--port N] [--json]` | Create variant (worktree + server) |
| `molt variants [--json]` | List variants with health status |
| `molt send --port <N> "<msg>"` | Send message, stream SSE response |
| `molt merge <name>` | Merge variant back and restart |

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
- Variants use git worktrees with detached server processes
- Variant metadata stored in `.molt/variants.json`
- Supervisor handles crash recovery (3s delay) and merge-restart signals via `.molt/restart.json`
- All child process execution in MCP tools must be async (never use `execFileSync`) to avoid blocking the event loop and dropping SSE connections

## Development

```sh
npm install              # install dependencies
npm run dev              # run CLI in dev mode (via tsx)
npm run build            # build CLI to dist/
molt create test && cd test && molt start  # test end-to-end
```

The CLI is installed globally via `npm link` (requires `npm run build` first) or run in dev mode via `tsx src/cli.ts`.
