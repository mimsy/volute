# Message Routing

Messages are routed to sessions based on rules in `.config/routes.json`. Rules are evaluated in order; first match wins. Unmatched messages go to the `default` session (defaults to `"main"`).

## Config syntax

```json
{
  "rules": [
    { "channel": "discord:*", "session": "discord" },
    { "channel": "*", "isDM": true, "session": "${sender}" },
    { "channel": "*", "isDM": false, "session": "${channel}" },
    { "sender": "alice", "session": "alice" },
    { "channel": "system:*", "session": "$new" },
    { "channel": "discord:logs", "destination": "file", "path": "inbox/log.md" }
  ],
  "sessions": {
    "discord": { "batch": { "debounce": 20, "maxWait": 120, "triggers": ["@mymind"] }, "interrupt": false, "instructions": "Brief responses only." },
  },
  "default": "main",
  "gateUnmatched": true
}
```

## Match criteria (rule fields)

| Field | Type | Description |
|-------|------|-------------|
| `channel` | glob string | Channel URI (e.g. `discord:*`, `@*`, `#*`) |
| `sender` | glob string | Sender name |
| `isDM` | boolean | Match DMs (`true`) or group channels (`false`) |
| `participants` | number | Match exact participant count |

## Rule fields

| Field | Description |
|-------|-------------|
| `session` | Target session name. Supports `${sender}`, `${channel}` templates, or `$new` for a unique session per message |
| `destination` | `"mind"` (default) or `"file"` |
| `path` | File path when destination is `"file"` |

## Session config

The `sessions` section configures behavior per session. Keys are glob patterns matched against the resolved session name. First match wins.

| Field | Description |
|-------|-------------|
| `delivery` | Delivery mode: `"immediate"` (default), `"batch"`, or `{ "mode": "batch", "debounce": N, "maxWait": N }` |
| `interrupt` | Whether to interrupt an in-progress turn (default: `true`) |
| `instructions` | Instructions prepended to messages for this session (e.g. `"Brief responses only."`) |
| `batch` | Legacy alias for batch config (use `delivery` instead) |

## Batch config

Batch mode buffers messages and delivers them together. Configure in the `sessions` section.

`batch` can be a number (minutes, converted to `maxWait` in seconds) or an object:

| Field | Type | Description |
|-------|------|-------------|
| `debounce` | seconds | Wait for quiet period before flushing — resets on each new message |
| `maxWait` | seconds | Maximum time before forced flush, even during continuous activity |
| `triggers` | string[] | Patterns that cause immediate flush (case-insensitive substring match) |

Examples:
- `120` — shorthand: flush after 2 hours max (equivalent to `{ "maxWait": 7200 }`)
- `{ "debounce": 20, "maxWait": 120 }` — flush after 20s of quiet, or 2 minutes max
- `{ "debounce": 20, "maxWait": 120, "triggers": ["@mymind"] }` — same, but flush immediately on @mention
- `{ "triggers": ["urgent"] }` — no timer, flush only on trigger (or immediately if no timers)

Batched messages arrive as a single message with a `[Batch: N messages — ...]` header showing the channel URI and message count, followed by individual messages with `[sender — time]` prefixes.

## New-speaker interrupts

In batch mode, if you're mid-turn and a **new speaker** sends a message in the **same channel**, the pending batch is force-flushed with `interrupt: true` so you can incorporate the new voice. This prevents pile-ups in group conversations where multiple people are talking. The interrupt has a debounce cooldown (matching the session's debounce setting) and only fires within the `maxWait` window of the last delivery.

## Channel Gating

When `gateUnmatched` is `true` (the default), messages from channels without a matching rule are held:

1. First message from an unknown channel triggers a **[Channel Invite]** notification in your main session
2. The notification includes channel details, a message preview, and a suggested routing rule
3. Further messages are saved to `inbox/<channel>.md`
4. To accept: add a routing rule to `.config/routes.json`
5. To reject: delete the inbox file
6. Set `gateUnmatched: false` to route all unmatched messages to the default session
