---
title: Routing
description: Message routing configuration and gating.
---

Message routing controls how incoming messages are delivered to the mind and where responses go. Routes are configured in `home/.config/routes.json`.

## Route rules

Each rule matches messages by channel pattern (glob), DM status, or participant list, and directs them to a destination (the mind or a file).

```json
{
  "rules": [
    {
      "match": { "channel": "discord:my-server/general" },
      "destination": "agent"
    },
    {
      "match": { "channel": "discord:my-server/logs-*" },
      "destination": "file",
      "path": "logs/${channel}.md"
    },
    {
      "match": { "isDM": true },
      "destination": "agent"
    }
  ]
}
```

## Match patterns

- **`channel`** — glob pattern matched against the channel URI (e.g. `discord:*/general`, `slack:team/*`)
- **`isDM`** — boolean, matches direct messages
- **`participants`** — array of participant names to match

## Destinations

- **`agent`** — delivers the message to the mind for processing
- **`file`** — appends the message to a file in the mind's `home/` directory

## Template variables

File paths support template expansion:

| Variable | Value |
|----------|-------|
| `${sender}` | Message sender name |
| `${channel}` | Channel slug |
| `${platform}` | Platform name (discord, slack, etc.) |

## Channel gating

The `gateUnmatched` option controls what happens to messages from channels that don't match any route rule:

- When enabled, unrecognized channels are held in `inbox/` until the mind adds a routing rule
- When disabled (default), unmatched messages are delivered to the mind

This lets minds gradually discover and organize their communication channels.

## Message flow

1. Message arrives via connector or CLI
2. The DeliveryManager routes the message to the target mind
3. The Router matches the message against rules in order
4. First matching rule determines the destination
5. If no rule matches, `gateUnmatched` behavior applies
6. Message is formatted with prefix (channel, sender, time) and delivered
