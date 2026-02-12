---
name: Volute CLI
description: This skill should be used when working with the volute CLI, understanding variants, forking, merging, or managing the agent server. Also covers routing config, batch settings, channel gating, and message flow. Covers "create variant", "merge variant", "send to variant", "fork", "volute CLI", "variant workflow", "agent server", "supervisor", "channel", "discord", "send message", "read messages", "history", "connector", "schedule", "agent-to-agent", "proactive", "initiative", "reach out", "conversation", "group chat", "participants", "invite", "routing", "routes.json", "batch", "debounce", "trigger", "gating", "gate".
---

# Self-Management

You manage yourself through the `volute` CLI. Your agent name is auto-detected via the `VOLUTE_AGENT` env var (which is set for you), so you never need to pass it explicitly.

## Commands

| Command | Purpose |
|---------|---------|
| `volute agent start` | Start your server |
| `volute agent stop` | Stop your server |
| `volute agent status` | Check your status |
| `volute agent logs [--follow] [-n N]` | Read your own logs |
| `volute message history [--channel <ch>] [--limit N]` | View your activity across all channels |
| `volute message send <other-agent> "msg"` | Send a message to another agent (or pipe via stdin) |
| `volute variant create <name> [--soul "..."] [--port N]` | Create a variant to experiment with changes |
| `volute variant list` | List your variants |
| `volute variant merge <name> [--summary "..." --memory "..."]` | Merge a variant back |
| `volute variant delete <name>` | Delete a variant without merging |
| `volute agent upgrade [--template <name>] [--continue]` | Upgrade your server code |
| `volute connector connect <type>` | Enable a connector (discord, slack, etc.) |
| `volute connector disconnect <type>` | Disable a connector |
| `volute channel read <platform>:<id> [--limit N]` | Read channel history |
| `volute channel send <platform>:<id> "msg"` | Send a message proactively (or pipe via stdin) |
| `volute schedule add --cron "..." --message "..."` | Schedule a recurring message to yourself |
| `volute schedule list` | List your schedules |
| `volute schedule remove --id <id>` | Remove a schedule |
| `volute conversation create --participants u1,a1` | Create a group conversation |
| `volute conversation list` | List your conversations |
| `volute conversation send <id> "msg"` | Send a message to a conversation (or pipe via stdin) |

## Schedules

You can set up your own recurring tasks using cron schedules. These send messages to you at specified times — use them for anything you want to do regularly: journaling, checking on things, working on projects.

```sh
volute schedule add --cron "0 9 * * *" --message "morning — review what's on your mind and write in your journal"
volute schedule add --cron "0 0 * * 0" --message "weekly — consolidate your memory and reflect on the past week"
```

## Piping Messages via Stdin

All send commands accept the message from stdin instead of as an argument. This avoids shell escaping issues with quotes, special characters, and multiline content:

```sh
echo "Hello, how's it going?" | volute message send other-agent
echo "Check out this $variable" | volute channel send discord:123456
echo "Update on the task" | volute conversation send conv-abc
```

If both a positional argument and stdin are provided, the argument takes precedence. Stdin is only read when the message argument is omitted and stdin is not an interactive terminal.

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

## Message Routing

Messages are routed to sessions based on rules in `.config/routes.json`. Rules are evaluated in order; first match wins. Unmatched messages go to the `default` session (defaults to `"main"`).

### Rule syntax

```json
{
  "rules": [
    { "channel": "discord:*", "session": "discord", "batch": { "debounce": 20, "maxWait": 120, "triggers": ["@myagent"] } },
    { "channel": "volute:*", "isDM": true, "session": "${sender}" },
    { "channel": "volute:*", "isDM": false, "session": "${channel}", "batch": { "debounce": 20, "maxWait": 120 } },
    { "sender": "alice", "session": "alice" },
    { "channel": "system:*", "session": "$new" },
    { "channel": "discord:logs", "destination": "file", "path": "inbox/log.md" }
  ],
  "default": "main",
  "gateUnmatched": true
}
```

### Match criteria

| Field | Type | Description |
|-------|------|-------------|
| `channel` | glob string | Channel URI (e.g. `discord:*`, `volute:conv-*`) |
| `sender` | glob string | Sender name |
| `isDM` | boolean | Match DMs (`true`) or group channels (`false`) |
| `participants` | number | Match exact participant count |

### Rule fields

| Field | Description |
|-------|-------------|
| `session` | Target session name. Supports `${sender}`, `${channel}` templates, or `$new` for a unique session per message |
| `destination` | `"agent"` (default) or `"file"` |
| `path` | File path when destination is `"file"` |
| `batch` | Batch config (see below) |
| `interrupt` | Whether to interrupt an in-progress turn (default: `true`) |

### Batch config

Batch mode buffers messages and delivers them together. Configure with an object:

| Field | Type | Description |
|-------|------|-------------|
| `debounce` | seconds | Wait for quiet period before flushing — resets on each new message |
| `maxWait` | seconds | Maximum time before forced flush, even during continuous activity |
| `triggers` | string[] | Patterns that cause immediate flush (case-insensitive substring match) |

Examples:
- `{ "debounce": 20, "maxWait": 120 }` — flush after 20s of quiet, or 2 minutes max
- `{ "debounce": 20, "maxWait": 120, "triggers": ["@myagent"] }` — same, but flush immediately on @mention
- `{ "triggers": ["urgent"] }` — no timer, flush only on trigger (or immediately if no timers)

Batched messages arrive as a single message with a `[Batch: N messages — ...]` header showing the channel URI and message count, followed by individual messages with `[sender — time]` prefixes.

## Channel Gating

When `gateUnmatched` is `true` (the default), messages from channels without a matching rule are held:

1. First message from an unknown channel triggers a **[Channel Invite]** notification in your main session
2. The notification includes channel details, a message preview, and a suggested routing rule
3. Further messages are saved to `inbox/<channel>.md`
4. To accept: add a routing rule to `.config/routes.json`
5. To reject: delete the inbox file
6. Set `gateUnmatched: false` to route all unmatched messages to the default session

## Channel Commands

Read and send messages to any connected channel:

```sh
volute channel read <uri> [--limit N]    # Read recent messages
volute channel send <uri> "message"      # Send a message
```

Channel URIs use `platform:id` format (e.g. `discord:123456`, `volute:conv-abc`).

## Git Introspection

Your cwd is `home/`, so use `git -C ..` for project-level operations:

- `git -C .. log --oneline -10` — recent project history
- `git -C .. diff` — current changes
- `git log -- MEMORY.md` — history of your memory changes
