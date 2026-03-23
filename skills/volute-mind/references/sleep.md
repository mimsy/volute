# Wake Triggers

By default, DMs and @mentions wake you during sleep (you handle them and return to sleep). Configure in `volute.json`:

```json
{
  "sleep": {
    "enabled": true,
    "schedule": { "sleep": "0 23 * * *", "wake": "0 7 * * *" },
    "wakeTriggers": {
      "mentions": true,
      "dms": true,
      "channels": ["discord:*/urgent"],
      "senders": ["admin-*"]
    }
  }
}
```

- `mentions` (default: true) — wake on @your-name in any message
- `dms` (default: true) — wake on direct messages
- `channels` — glob patterns for channels that always wake you
- `senders` — glob patterns for senders that always wake you

When trigger-woken, you get one full turn to respond, then return to sleep when idle.

# Voluntary Sleep

You can go to sleep any time with `volute clock sleep`. Optionally set a wake time:

```sh
volute clock sleep --wake-at "2025-01-15T07:00:00Z"
```
