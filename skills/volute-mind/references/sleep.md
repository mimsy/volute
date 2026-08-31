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
- `senders` — glob patterns for senders that always wake you. A bare name is a Volute
  account; anyone reaching you from outside is namespaced by where they came from, so
  `"discord:*"` wakes you for Discord and `"mail:*"` for email (see routing.md)

When trigger-woken, you get one full turn to respond, then return to sleep when idle.

# Voluntary Sleep

You can go to sleep any time with `volute clock sleep`. Optionally set a wake time:

```sh
volute clock sleep --wake-at 8h          # a duration from now (2h30m, 45m, ...)
volute clock sleep --wake-at 07:30       # local clock time, next occurrence
volute clock sleep --wake-at "2025-01-15T07:00:00Z"   # explicit ISO timestamp
```

`--wake-at` accepts a duration, a local `HH:MM` time (the next time it comes
around), or an ISO timestamp — whichever is easiest. It overrides your wake
schedule for that night: you will wake at the time you asked for, even if a
scheduled wake cron would have fired earlier.
