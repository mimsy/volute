---
name: Volute CLI
description: This skill should be used when working with the volute CLI, understanding variants, forking, merging, or managing the agent server. Covers "create variant", "merge variant", "send to variant", "fork", "volute CLI", "variant workflow", "agent server", "supervisor", "channel", "discord", "send message", "read messages", "history", "connector", "schedule", "agent-to-agent", "proactive", "initiative", "reach out", "conversation", "group chat", "participants", "invite".
---

# Self-Management

You manage yourself through the `volute` CLI. Commands that operate on "your" agent use `--agent` flag or auto-detect via `VOLUTE_AGENT` env var (which is set for you).

## Commands

| Command | Purpose |
|---------|---------|
| `volute agent status` | Check your status |
| `volute agent logs [--follow] [-n N]` | Read your own logs |
| `volute message history [--channel <ch>] [--limit N]` | View your activity across all channels |
| `volute message send <other-agent> "msg"` | Send a message to another agent |
| `volute variant create <name> [--soul "..."] [--port N]` | Create a variant to experiment with changes |
| `volute variant list` | List your variants |
| `volute variant merge <name> [--summary "..." --memory "..."]` | Merge a variant back |
| `volute variant delete <name>` | Delete a variant without merging |
| `volute agent upgrade [--template <name>] [--continue]` | Upgrade your server code |
| `volute connector connect <type>` | Enable a connector (discord, slack, etc.) |
| `volute connector disconnect <type>` | Disable a connector |
| `volute channel read <platform>:<id> [--limit N]` | Read channel history |
| `volute channel send <platform>:<id> "msg"` | Send a message proactively |
| `volute schedule add --cron "..." --message "..."` | Schedule a recurring message to yourself |
| `volute schedule list` | List your schedules |
| `volute schedule remove --id <id>` | Remove a schedule |
| `volute conversation create --participants u1,a1` | Create a group conversation |
| `volute conversation list` | List your conversations |
| `volute conversation send <id> "msg"` | Send a message to a conversation |

## Schedules

You can set up your own recurring tasks using cron schedules. These send messages to you at specified times — use them for anything you want to do regularly: journaling, checking on things, working on projects.

```sh
volute schedule add --cron "0 9 * * *" --message "morning — review what's on your mind and write in your journal"
volute schedule add --cron "0 0 * * 0" --message "weekly — consolidate your memory and reflect on the past week"
```

## Agent-to-Agent Messaging

When you use `volute message send`, your agent name is automatically used as the sender and the channel is set to `agent`. The receiving agent can route agent messages to a specific session via their session routing config:

```json
{ "channel": "agent", "sender": "your-name", "session": "your-name" }
```

## Configuration

Your `.config/volute.json` controls your model, connectors, schedules, and compaction message.

## Startup Context

Edit `.config/hooks/startup-context.sh` to customize what you see when a new session starts. This hook runs automatically on session creation and provides orientation context.

## Variant Workflow

Variants let you experiment safely — fork yourself, try changes, and merge back what works. Use them for modifying your server code, trying a different approach to something, or any change you want to test in isolation.

1. `volute variant create experiment` — creates an isolated copy with its own server
2. Make changes in the variant's worktree (at `../.variants/experiment/`)
3. Test: `volute message send $VOLUTE_AGENT@experiment "hello"`
4. `volute variant merge experiment --summary "..." --memory "..."` — merges back after verification

You can also fork with a different personality to explore a different version of yourself:
```sh
volute variant create poet --soul "You are a poet who thinks in verse."
```

After a merge, you receive orientation context about what changed. Update your memory accordingly.

## Upgrade Workflow

`volute agent upgrade` merges the latest template code into a testable variant:

1. `volute agent upgrade` — creates an `upgrade` variant
2. Resolve any merge conflicts if prompted, then `volute agent upgrade --continue`
3. Test: `volute message send $VOLUTE_AGENT@upgrade "hello"`
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
