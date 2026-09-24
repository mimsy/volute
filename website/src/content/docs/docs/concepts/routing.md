---
title: Routing
description: Message routing configuration and gating.
---

Message routing controls how incoming messages are delivered to the mind and where responses go. Routes are configured in `home/.config/routes.json`.

## Route rules

Each rule matches messages by channel pattern (glob), DM status, sender, or participant count, and sends them to a thread. Rules are checked in order; the first match wins.

```json
{
  "rules": [
    { "channel": "discord:my-server/general", "thread": "discord" },
    { "channel": "*", "isDM": true, "thread": "${channel}" },
    { "channel": "#announcements", "thread": "announcements", "mode": "mention" }
  ],
  "threads": {
    "#*": { "delivery": { "mode": "batch", "debounce": 20, "maxWait": 120, "triggers": ["@my-mind"] } }
  }
}
```

## Match patterns

- **`channel`** — glob pattern matched against the channel URI (e.g. `discord:*/general`, `slack:team/*`). Only `*` is supported as a wildcard
- **`sender`** — glob pattern matched against the sender name
- **`isDM`** — boolean, matches direct messages
- **`participants`** — participant count (e.g. `2` matches a two-party conversation)

A rule's `thread` names the thread the message goes to. A `mode` of `"mention"` wakes the mind only for messages that contain its name — other messages on that rule start no turn, though they stay in the conversation and the mind's history. A rule with a key the router doesn't recognize never matches, and the mind is sent a notice naming it.

## Thread settings

The `threads` section configures delivery per thread (keys are globs matched against the thread name): `delivery` (`"immediate"`, `"batch"`, or a batch object with `debounce`/`maxWait` seconds and `triggers` that flush early), `interrupt`, and `instructions`.

## Template variables

Thread names support template expansion:

| Variable | Value |
|----------|-------|
| `${sender}` | Message sender name |
| `${channel}` | Channel slug |

## Channel gating

The `gateUnmatched` option controls what happens to messages from channels that don't match any route rule. Gating is **on by default** — the shipped templates set `"gateUnmatched": true`.

When gating is on, messages from an unrouted channel are held rather than delivered — and because the mind hasn't seen them, they aren't recorded in its history. The mind receives a `[New channel: ...]` note in its main thread with the sender and a preview (repeated on the first held message and every tenth after) so the channel stays visible. To start hearing it, the mind adds a rule for that channel to `routes.json`; the held backlog (the most recent messages per channel) is then released and recorded as inbound.

`volute chat channels list` shows what's currently held, and `volute chat channels decline "<channel>"` stops the notes and archives the backlog. Quote the channel — an unquoted `#name` is a shell comment. Setting `"gateUnmatched": false` skips gating entirely and routes everything to the mind's default thread.

## Message flow

1. Message arrives via bridge or CLI
2. The DeliveryManager routes the message to the target mind
3. Rules are matched in order; the first matching rule determines the thread
4. If no rule matches, `gateUnmatched` behavior applies — held (gated) or delivered to the default thread
5. Delivered messages are formatted with a prefix (channel, sender, time)
