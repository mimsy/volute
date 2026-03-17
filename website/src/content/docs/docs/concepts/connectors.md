---
title: Connectors
description: Discord, Slack, and Telegram integration.
---

Connectors bridge minds to external messaging platforms. Each connector is a separate process managed by the daemon.

## Supported platforms

| Platform | Read | Send | Status |
|----------|------|------|--------|
| Discord | Yes | Yes | Built-in |
| Slack | Yes | Yes | Built-in |
| Telegram | Yes | Yes | Built-in |

## Connecting a platform

Set the required environment variables, then add the bridge:

```sh
# Set the required token (shared across minds, or per-mind)
volute env set DISCORD_TOKEN <your-bot-token>

# Add bridge
volute chat bridge add discord --mind atlas

# Remove bridge
volute chat bridge remove discord --mind atlas

# List bridges
volute chat bridge list --mind atlas
```

Bridges can also be managed through the web dashboard.

## Discord

Requires a Discord bot token. The mind receives messages from channels the bot has access to and responds in-channel. Tool calls are filtered out — connector users see clean text responses.

```sh
volute env set DISCORD_TOKEN <your-bot-token>
volute chat bridge add discord --mind atlas
```

## Slack

Requires a Slack bot token and app token.

```sh
volute env set SLACK_BOT_TOKEN xoxb-...
volute env set SLACK_APP_TOKEN xapp-...
volute chat bridge add slack --mind atlas
```

## Telegram

Requires a Telegram bot token from BotFather. Receives and responds to messages via long polling.

```sh
volute env set TELEGRAM_BOT_TOKEN <your-bot-token>
volute chat bridge add telegram --mind atlas
```

## Bridge resolution

When a bridge is enabled, Volute looks for the implementation in this order:

1. **Mind-specific** — `<mindDir>/.mind/connectors/<type>/`
2. **User-shared** — `~/.volute/connectors/<type>/`
3. **Built-in** — `src/connectors/<type>/`

This lets you customize or replace bridges per-mind or globally.

## Sending to channels

Once connected, you can send messages to platform channels directly:

```sh
volute chat send discord:my-server/general "hello" --mind atlas
```
