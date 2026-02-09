---
name: Volute CLI
description: This skill should be used when working with the volute CLI, understanding variants, forking, merging, or managing the agent server. Covers "create variant", "merge variant", "send to variant", "fork", "volute CLI", "variant workflow", "agent server", "supervisor", "channel", "discord", "send message", "read messages", "history", "connector", "schedule", "agent-to-agent".
---

# Self-Management

You manage yourself through the `volute` CLI. Commands that operate on "your" agent use `--agent` flag or auto-detect via `VOLUTE_AGENT` env var (which is set for you).

## Commands

| Command | Purpose |
|---------|---------|
| `volute status` | Check your status |
| `volute logs [--follow] [-n N]` | Read your own logs |
| `volute history [--channel <ch>] [--limit N]` | View your activity across all channels |
| `volute send <other-agent> "msg"` | Send a message to another agent |
| `volute variant create <name> [--soul "..."] [--port N]` | Create a variant for testing changes |
| `volute variant list` | List your variants |
| `volute variant merge <name> [--summary "..." --memory "..."]` | Merge a variant back |
| `volute upgrade [--template <name>] [--continue]` | Upgrade your server code |
| `volute connector connect <type>` | Enable a connector (e.g. discord) |
| `volute connector disconnect <type>` | Disable a connector |
| `volute channel read discord:<id> [--limit N]` | Read channel history |
| `volute channel send discord:<id> "msg"` | Send a message proactively |

## Agent-to-Agent Messaging

When you use `volute send`, your agent name is automatically used as the sender and the channel is set to `agent`. The receiving agent can route agent messages to a specific session via their session routing config:

```json
{ "channel": "agent", "sender": "your-name", "session": "your-name" }
```

## Configuration

Your `.config/volute.json` controls your model, connectors, schedules, and compaction message.

## Startup Context

Edit `.config/hooks/startup-context.sh` to customize what you see when a new session starts. This hook runs automatically on session creation and provides orientation context.

## Variant Workflow

For changes to your server code (`src/`), use variants to test safely:

1. `volute variant create experiment` — creates an isolated copy with its own server
2. Make changes in the variant's worktree (at `../.worktrees/experiment/`)
3. Test: `volute send $VOLUTE_AGENT@experiment "hello"`
4. `volute variant merge experiment --summary "..." --memory "..."` — merges back after verification

After a merge, you receive orientation context about what changed. Update your memory accordingly.

## Upgrade Workflow

`volute upgrade` merges the latest template code into a testable variant:

1. `volute upgrade` — creates an `upgrade` variant
2. Resolve any merge conflicts if prompted, then `volute upgrade --continue`
3. Test: `volute send $VOLUTE_AGENT@upgrade "hello"`
4. `volute variant merge upgrade` — merge back

## Custom Skills

Create skills by writing `.claude/skills/<name>/SKILL.md` files in your `home/` directory. These are automatically available in your sessions.

## MCP Configuration

Edit `home/.mcp.json` to configure MCP servers for your SDK session. This gives you access to additional tools and services.

## Git Introspection

Your cwd is `home/`, so use `git -C ..` for project-level operations:

- `git -C .. log --oneline -10` — recent project history
- `git -C .. diff` — current changes
- `git log -- MEMORY.md` — history of your memory changes
