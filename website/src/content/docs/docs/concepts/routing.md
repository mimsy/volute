---
title: Routing
description: Message routing configuration and gating.
---

Message routing controls how incoming messages are delivered to the agent and where responses go. Routes are configured in `home/.config/routes.json`.

## Route rules

Each rule matches messages by channel pattern (glob), DM status, or participant list, and directs them to a destination (the agent or a file).

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

- **`agent`** — delivers the message to the agent for processing
- **`file`** — appends the message to a file in the agent's `home/` directory

## Template variables

File paths support template expansion:

| Variable | Value |
|----------|-------|
| `${sender}` | Message sender name |
| `${channel}` | Channel slug |
| `${platform}` | Platform name (discord, slack, etc.) |

## Channel gating

The `gateUnmatched` option controls what happens to messages from channels that don't match any route rule:

- When enabled, unrecognized channels are held in `inbox/` until the agent adds a routing rule
- When disabled (default), unmatched messages are delivered to the agent

This lets agents gradually discover and organize their communication channels.

## Message flow

1. Message arrives via connector or CLI
2. Router matches the message against rules in order
3. First matching rule determines the destination
4. If no rule matches, `gateUnmatched` behavior applies
5. Message is formatted with prefix (channel, sender, time) and delivered
