# Message Routing

Messages are routed to threads based on rules in `.config/routes.json`. Rules are evaluated in order; first match wins. Unmatched messages go to the `default` thread (defaults to `"main"`). Each thread has its own conversation history.

## Config syntax

```json
{
  "rules": [
    { "channel": "discord:*", "thread": "discord" },
    { "channel": "*", "isDM": true, "thread": "${sender}" },
    { "channel": "*", "isDM": false, "thread": "${channel}" },
    { "sender": "alice", "thread": "alice" },
    { "channel": "system:*", "thread": "$new" },
    { "channel": "discord:logs", "destination": "file", "path": "notes/log.md" }
  ],
  "threads": {
    "discord": { "delivery": { "mode": "batch", "debounce": 20, "maxWait": 120, "triggers": ["@mymind"] }, "instructions": "Brief responses only." },
    "urgent": { "interrupt": true }
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
| `thread` | Target thread name. Supports `${sender}`, `${channel}` templates, or `$new` for a unique thread per message |
| `destination` | `"mind"` (default) or `"file"` |
| `path` | File path when destination is `"file"` |
| `batch` | Batch config for messages matched by this rule (same shape as thread-level batching, below) |

## Thread config

The `threads` section configures behavior per thread. Keys are glob patterns matched against the resolved thread name. First match wins.

| Field | Description |
|-------|-------------|
| `delivery` | `"immediate"` (default), `"batch"`, or `{ "mode": "batch", "debounce": N, "maxWait": N, "triggers": [...] }` |
| `interrupt` | Whether a new message may interrupt an in-progress turn (default: `false`) |
| `instructions` | Instructions prepended to messages for this thread (e.g. `"Brief responses only."`) |

## Batch config

Batch mode buffers messages and delivers them together. Configure via the thread-level `delivery` field, or via `batch` on a rule.

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

1. A **[New channel: ...]** note arrives in your main thread with the sender and a preview. It repeats on a cadence (the 1st held message, then every 10th) so a channel you never routed stays visible instead of going silent — and repeat notes tell you how many messages are being held.
2. Held messages wait in the delivery queue — they are **not** recorded in your history and don't count as messages you've received, because you haven't seen them yet. Nothing is lost: read them with `volute chat channels peek <channel>`. (`volute chat read` can't show them — held messages have no conversation yet.)
3. **To accept**, run `volute chat channels accept <channel>` (optionally `--thread <name>`). That adds the routing rule for you, releases the backlog immediately, and tells you how many messages were released. Only the **10 most recent** per channel are delivered; a summary tells you how many older ones were held, and `peek` still shows them. Delivered messages are recorded as inbound then, when you actually receive them.
4. **To decline**, run `volute chat channels decline <channel>`. That stops the repeat notes and archives the current backlog. Merely leaving a channel unrouted is *not* declining — the notes keep coming until you accept or decline it. Accepting later still works and un-declines the channel.
5. `volute chat channels list` shows every unrouted channel currently holding messages, with counts.
6. Set `gateUnmatched: false` to route all unmatched messages to the default thread instead of gating.

### When routing changes take effect

`accept` applies immediately: it writes the rule, releases the backlog, and reports the count in the same command. Prefer it.

Hand-editing `.config/routes.json` also works, but it is noticed **lazily** — the daemon re-reads the file (mtime check, cached ~5s) on the *next inbound message* for that mind. On a quiet mind, editing the file releases nothing until traffic arrives, which for a channel whose only messages are already held may be never. If you've hand-edited and are waiting on held messages, run `accept` (it's idempotent — an existing rule isn't duplicated) rather than waiting.

Edits made while the daemon was down are picked up at startup: a sweep re-evaluates every mind's held messages against current routing.

One trap: a rule containing an **unrecognized key** never matches anything, so with gating on its channel's messages silently go to the gate. The daemon logs a warning naming the key when it loads such a config.
