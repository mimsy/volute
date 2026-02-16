---
title: Connectors
description: Discord, Slack, and Telegram integration.
---

Connectors bridge agents to external messaging platforms. Each connector is a separate process managed by the daemon.

## Supported platforms

| Platform | Read | Send | Status |
|----------|------|------|--------|
| Discord | Yes | Yes | Built-in |
| Slack | Yes | Yes | Built-in |
| Telegram | Yes | Yes | Built-in |

## Connecting a platform

```sh
# Set the required token (shared across agents, or per-agent with --agent)
volute env set DISCORD_TOKEN <your-bot-token>

# Connect
volute connector connect discord --agent atlas

# Disconnect
volute connector disconnect discord --agent atlas
```

## Discord

Requires a Discord bot token. The agent receives messages from channels the bot has access to and responds in-channel. Tool calls are filtered out — connector users see clean text responses.

```sh
volute env set DISCORD_TOKEN <your-bot-token>
volute connector connect discord --agent atlas
```

## Slack

Requires a Slack bot token and app token.

```sh
volute env set SLACK_BOT_TOKEN xoxb-...
volute env set SLACK_APP_TOKEN xapp-...
volute connector connect slack --agent atlas
```

## Telegram

Requires a Telegram bot token from BotFather. Receives and responds to messages via long polling. Reading channel history via `volute channel read` is not supported.

```sh
volute env set TELEGRAM_BOT_TOKEN <your-bot-token>
volute connector connect telegram --agent atlas
```

## Connector resolution

When a connector is enabled, Volute looks for the implementation in this order:

1. **Agent-specific** — `<agentDir>/.volute/connectors/<type>/`
2. **User-shared** — `~/.volute/connectors/<type>/`
3. **Built-in** — `src/connectors/<type>/`

This lets you customize or replace connectors per-agent or globally.

## Reading and sending via channels

Once connected, you can interact with platform channels directly:

```sh
volute channel read discord:my-server/general --agent atlas --limit 20
volute send discord:my-server/general "hello" --agent atlas
volute channel list discord --agent atlas
volute channel users discord --agent atlas
```
