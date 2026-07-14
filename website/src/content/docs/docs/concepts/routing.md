---
title: Routing
description: Message routing configuration and gating.
---

Message routing controls how incoming messages are delivered to the mind and where responses go. Routes are configured in `home/.config/routes.json`.

## Route rules

Each rule matches messages by channel pattern (glob), DM status, sender, or participant count, and directs them to a destination — the mind or a file.

```json
{
  "rules": [
    {
      "match": { "channel": "discord:my-server/general" },
      "destination": "mind"
    },
    {
      "match": { "channel": "discord:my-server/logs-*" },
      "destination": "file",
      "path": "logs/${channel}.md"
    },
    {
      "match": { "isDM": true },
      "destination": "mind"
    }
  ]
}
```

## Match patterns

- **`channel`** — glob pattern matched against the channel URI (e.g. `discord:*/general`, `slack:team/*`). Only `*` is supported as a wildcard
- **`sender`** — glob pattern matched against the sender name
- **`isDM`** — boolean, matches direct messages
- **`participants`** — participant count (e.g. `2` matches a two-party conversation)

## Destinations

- **`mind`** — delivers the message to the mind for processing (the default when no `destination` is set)
- **`file`** — appends the message to a file in the mind's `home/` directory (requires `path`)

A mind-destination rule can also set a `thread` to route the message into a named session, and a `mode` of `"mention"` to only wake the mind when its name appears in the message.

## Template variables

File paths and thread names support template expansion:

| Variable | Value |
|----------|-------|
| `${sender}` | Message sender name |
| `${channel}` | Channel slug |

## Channel gating

The `gateUnmatched` option controls what happens to messages from channels that don't match any route rule. Gating is **on by default** — the shipped templates set `"gateUnmatched": true`.

When gating is on, messages from an unrouted channel are held rather than delivered — and because the mind hasn't seen them, they aren't recorded in its history. The mind receives a `[New channel: ...]` note in its main thread with the sender and a preview (repeated on the first held message and every tenth after) so the channel stays visible. To start hearing it, the mind adds a rule for that channel to `routes.json`; the held backlog (the most recent messages per channel) is then released and recorded as inbound.

`volute chat channels list` shows what's currently held, and `volute chat channels decline <channel>` stops the notes and archives the backlog. Setting `"gateUnmatched": false` skips gating entirely and routes everything to the mind's default thread.

## Message flow

1. Message arrives via bridge or CLI
2. The DeliveryManager routes the message to the target mind
3. Rules are matched in order; the first matching rule determines the destination
4. If no rule matches, `gateUnmatched` behavior applies — held (gated) or delivered to the default thread
5. Delivered messages are formatted with a prefix (channel, sender, time)
