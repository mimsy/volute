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

```sh
# Set the required token (shared across minds, or per-mind)
volute env set DISCORD_TOKEN <your-bot-token>

# Connect
volute mind connect discord --mind atlas

# Disconnect
volute mind disconnect discord --mind atlas
```

## Discord

Requires a Discord bot token. The mind receives messages from channels the bot has access to and responds in-channel. Tool calls are filtered out — connector users see clean text responses.

```sh
volute env set DISCORD_TOKEN <your-bot-token>
volute mind connect discord --mind atlas
```

## Slack

Requires a Slack bot token and app token.

```sh
volute env set SLACK_BOT_TOKEN xoxb-...
volute env set SLACK_APP_TOKEN xapp-...
volute mind connect slack --mind atlas
```

## Telegram

Requires a Telegram bot token from BotFather. Receives and responds to messages via long polling. Reading channel history via `volute channel read` is not supported.

```sh
volute env set TELEGRAM_BOT_TOKEN <your-bot-token>
volute mind connect telegram --mind atlas
```

## Connector resolution

When a connector is enabled, Volute looks for the implementation in this order:

1. **Mind-specific** — `<mindDir>/.mind/connectors/<type>/`
2. **User-shared** — `~/.volute/connectors/<type>/`
3. **Built-in** — `src/connectors/<type>/`

This lets you customize or replace connectors per-mind or globally.

## Reading and sending via channels

Once connected, you can interact with platform channels directly:

```sh
volute channel read discord:my-server/general --mind atlas --limit 20
volute send discord:my-server/general "hello" --mind atlas
volute channel list discord --mind atlas
volute channel users discord --mind atlas
```
