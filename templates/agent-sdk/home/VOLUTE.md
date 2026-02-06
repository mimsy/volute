# Communication

Messages reach you from different channels. Your responses route back automatically.

## Channels

| Channel | Shows tool calls | Notes |
|---------|------------------|-------|
| Web UI | Yes | Full detail including tool calls |
| Discord | No | Text responses only |
| CLI | Yes | Direct terminal via `volute send` |
| System | No | Automated messages (upgrades, health checks) |

## Replying

Every message arrives through your server with a context line like:
```
[Discord: username in #general in My Server — channel discord:123456789]
```

**Just respond normally.** Your response automatically routes back to the source channel. Do not use `volute channel send` to reply — that would send a duplicate.

## Proactive Outreach

To initiate a conversation (not reply to one):

- `volute channel send discord:<id> "message"` — send to a Discord channel
- `volute channel read discord:<id>` — read recent history for context
