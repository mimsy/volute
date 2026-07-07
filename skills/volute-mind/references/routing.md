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
    { "channel": "discord:logs", "destination": "file", "path": "notes/log.md" }
  ],
  "sessions": {
    "discord": { "delivery": { "mode": "batch", "debounce": 20, "maxWait": 120, "triggers": ["@mymind"] }, "interrupt": false, "instructions": "Brief responses only." }
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
| `batch` | Batch config for messages matched by this rule (same shape as session-level batching, below) |

## Session config

The `sessions` section configures behavior per session. Keys are glob patterns matched against the resolved session name. First match wins.

| Field | Description |
|-------|-------------|
| `delivery` | `"immediate"` (default), `"batch"`, or `{ "mode": "batch", "debounce": N, "maxWait": N, "triggers": [...] }` |
| `interrupt` | Whether a new message may interrupt an in-progress turn (default: `true`) |
| `instructions` | Instructions prepended to messages for this session (e.g. `"Brief responses only."`) |

## Batch config

Batch mode buffers messages and delivers them together. Configure via the session-level `delivery` field, or via `batch` on a rule.

A rule-level `batch` can be a number (minutes, converted to `maxWait`) or an object:

| Field | Type | Description |
|-------|------|-------------|
| `debounce` | seconds | Wait for a quiet period before flushing — resets on each new message (default: 5) |
| `maxWait` | seconds | Maximum time before forced flush, even during continuous activity (default: 120) |
| `triggers` | string[] | Patterns that cause immediate flush (case-insensitive substring match) |

Examples:
- `"batch": 120` — rule-level shorthand: flush after 2 hours max (equivalent to `{ "maxWait": 7200 }`)
- `{ "debounce": 20, "maxWait": 120 }` — flush after 20s of quiet, or 2 minutes max
- `{ "debounce": 20, "maxWait": 120, "triggers": ["@mymind"] }` — same, but flush immediately on @mention

Unspecified fields fall back to the defaults (debounce 5s, maxWait 120s), so a config with only `triggers` still flushes on the default timers.

Batched messages arrive as a single message with a header — `[Batch: N messages from #channel]` for one channel, or `[Batch: N messages — 2 from #a, 1 from #b]` across several — followed by the individual messages with `[sender — time]` prefixes.

## New Channels (gating)

When `gateUnmatched` is `true` (the default), messages from channels without a matching rule are held for you:

1. The first message from an unknown channel sends a **[New channel: ...]** note to your main session with the sender and a preview
2. Further messages are held safely in the delivery queue — nothing is lost
3. To accept: add a routing rule for the channel to `.config/routes.json` — held messages are delivered as soon as the new rules match them
4. To decline: simply leave the channel unrouted
5. Set `gateUnmatched: false` to route all unmatched messages to the default session instead
