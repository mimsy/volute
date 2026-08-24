---
title: Mind configuration
description: The config files in a mind's home/.config/ directory.
---

A mind's configuration lives in `home/.config/`. Most of it is editable from the dashboard (the mind's Settings section), but the files are plain JSON and a mind can read and rewrite its own — part of how a mind understands and shapes its own framework.

## volute.json

Volute-level configuration: identity, presentation, rhythm, and budget. Read by the daemon.

| Field | Type | Purpose |
|-------|------|---------|
| `identity` | `{ privateKey, publicKey }` | The mind's Ed25519 keypair (see [Identity](/docs/concepts/identity/)) |
| `profile` | `{ displayName?, description?, avatar? }` | Display name, description, and avatar path (relative to `home/`) |
| `schedules` | `Schedule[]` | Scheduled messages and scripts (see [clock](/docs/commands/clock/)) |
| `sleep` | `SleepConfig` | Sleep/wake cycle configuration (see below) |
| `model` | `string` | Model override |
| `thinkingLevel` | `"off"…"xhigh"` | Reasoning depth |
| `spendCap` | `number` | Spend cap in USD per budget period |
| `spendCapPeriodMinutes` | `number` | Length of the budget period in minutes (default 1440) |
| `echoText` | `boolean` | Echo the mind's text output back to it |
| `unescapeNewlines` | `boolean` | Unescape `\n` in incoming messages |

Each entry in `schedules` has an `id`, `enabled`, and either a `cron` expression or a one-time `fireAt` timestamp, plus a `message` (or `messages` pool) or a `script`. Optional `thread` targets a thread, and `whileSleeping` (`skip` | `queue` | `trigger-wake`) controls behavior during sleep.

### sleep

```json
{
  "sleep": {
    "enabled": true,
    "schedule": { "sleep": "0 23 * * *", "wake": "0 8 * * *" },
    "wakeTriggers": {
      "mentions": true,
      "dms": true,
      "channels": ["discord:my-server/urgent-*"],
      "senders": ["alice"]
    }
  }
}
```

`schedule` holds `sleep` and `wake` cron expressions. `wakeTriggers` decides what wakes a sleeping mind — `mentions` and `dms` both default to `true`, while `channels` and `senders` (glob patterns) are opt-in. See [Sleep](/docs/concepts/sleep/).

## config.json

SDK-level configuration, loaded by the mind's server at startup.

| Field | Type | Purpose |
|-------|------|---------|
| `model` | `string` | Model the mind runs on |
| `compaction` | `{ maxContextTokens? }` | Token threshold that triggers compaction |
| `compactionMessage` | `string` | Message shown to the mind before compaction |
| `sessionIdleMinutes` | `number` | Idle minutes before a session's subprocess is reaped (default 30, `0` disables) |
| `logLevel` | `"error"…"debug"` | Log verbosity |
| `subagents` | `Record<string, …>` | Named subagent definitions |
| `thinking` / `effort` / `thinkingLevel` / `reasoningEffort` | — | Template-specific extended-thinking controls passed to the SDK |

## routes.json

Message routing rules — which channels a mind handles and where their messages go. See [Routing](/docs/concepts/routing/) for the full format.
