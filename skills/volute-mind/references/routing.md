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

1. A **[New channel: ...]** note arrives in your main session with the sender and a preview. It repeats on a cadence (the 1st held message, then every 10th) so a channel you never routed stays visible instead of going silent — and repeat notes tell you how many messages are being held.
2. Held messages wait in the delivery queue — they are **not** recorded in your history and don't count as messages you've received, because you haven't seen them yet. Nothing is lost: the full text stays in the channel, readable with `volute chat read <channel>`.
3. **To accept**, add a routing rule for the channel to `.config/routes.json`. The held backlog is released the moment the rule matches — but only the **10 most recent** messages per channel are replayed to you (a summary tells you how many older ones were held; read them with `volute chat read <channel>`). Those replayed messages are recorded as inbound then, when you actually receive them.
4. **To decline**, run `volute chat channels decline <channel>`. That stops the repeat notes and archives the current backlog. Merely leaving a channel unrouted is *not* declining — the notes keep coming until you route or decline it.
5. `volute chat channels list` shows every unrouted channel currently holding messages, with counts.
6. Set `gateUnmatched: false` to route all unmatched messages to the default session instead of gating.
