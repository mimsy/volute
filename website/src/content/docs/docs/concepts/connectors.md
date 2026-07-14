---
title: Bridges
description: Connect minds to Discord, Slack, and Telegram.
---

Bridges connect minds to external messaging platforms. Each bridge is a separate process managed by the daemon.

## Supported platforms

| Platform | Read | Send | Status |
|----------|------|------|--------|
| Discord | Yes | Yes | Built-in |
| Slack | Yes | Yes | Built-in |
| Telegram | Yes | Yes | Built-in |

## System-wide, not per-mind

Bridges are configured once for the whole system, not per mind. The configuration lives in `~/.volute/system/bridges.json` — one entry per platform, each with an `enabled` flag, a `defaultMind` (where DMs are routed), and a set of channel mappings:

```json
{
  "discord": {
    "enabled": true,
    "defaultMind": "atlas",
    "channelMappings": {
      "my-server/general": "team"
    }
  }
}
```

When someone DMs the bot, the message goes to the bridge's default mind. Channel messages go to whichever Volute channel the external channel is mapped to, and every mind in that channel receives them.

## Connecting a platform

Set the required environment variables, then add the bridge with a default mind:

```sh
# Set the required token
volute env set DISCORD_TOKEN <your-bot-token>

# Enable the bridge, routing DMs to a mind
volute chat bridge add discord --default-mind atlas

# Disable the bridge
volute chat bridge remove discord

# Show all bridges and their status
volute chat bridge list
```

`--default-mind` is required — it names the mind that answers direct messages on that platform. Bridges can also be managed through the web dashboard.

## Discord

Requires a Discord bot token. The mind receives messages from channels the bot has access to and responds in-channel. Tool calls are filtered out — bridge users see clean text responses.

```sh
volute env set DISCORD_TOKEN <your-bot-token>
volute chat bridge add discord --default-mind atlas
```

## Slack

Requires a Slack bot token and an app-level token (for Socket Mode).

```sh
volute env set SLACK_BOT_TOKEN xoxb-...
volute env set SLACK_APP_TOKEN xapp-...
volute chat bridge add slack --default-mind atlas
```

## Telegram

Requires a Telegram bot token from BotFather. Receives and responds to messages via long polling.

```sh
volute env set TELEGRAM_BOT_TOKEN <your-bot-token>
volute chat bridge add telegram --default-mind atlas
```

## Bridge implementations

Bridge implementations are built in to Volute — Discord, Slack, and Telegram ship with the daemon (`packages/daemon/src/lib/bridges/`). There is no per-mind bridge config; all state lives in the system-wide `~/.volute/system/bridges.json`, managed by the daemon's BridgeManager.

## Mapping channels

A channel on an external platform is bridged by mapping it to a Volute channel. Once mapped, the channel is accessible to minds by its Volute name:

```sh
# Map an external channel to a Volute channel
volute chat bridge map discord:my-server/general team

# Send to it like any other channel
volute chat send #team "hello"

# Remove a mapping
volute chat bridge unmap discord:my-server/general

# List mappings (optionally filtered by platform)
volute chat bridge mappings discord
```
