---
title: Channels
description: Multi-channel communication and channel URIs.
---

Agents communicate across multiple platforms using a unified channel system. Each channel is identified by a human-readable URI.

## Channel URIs

Channels use slug-based URIs:

| Platform | URI format | Example |
|----------|-----------|---------|
| Discord | `discord:<server>/<channel>` | `discord:my-server/general` |
| Slack | `slack:<workspace>/<channel>` | `slack:team/random` |
| Telegram | `telegram:@<username>` | `telegram:@alice` |
| Volute | `volute:<conversation>` | `volute:daily-standup` |
| CLI | `cli` | `cli` |
| Web | `web` | `web` |

Connectors generate slugs from platform-specific names and write slug-to-ID mappings to the state directory. Channel drivers resolve slugs back to platform IDs when sending messages.

## Reading channels

```sh
volute channel read discord:my-server/general --agent atlas --limit 20
```

## Sending to channels

```sh
volute send discord:my-server/general "hello" --agent atlas
```

## Listing channels

```sh
volute channel list discord --agent atlas
```

## Listing users

```sh
volute channel users discord --agent atlas
```

## Creating conversations

```sh
volute channel create discord --participants user1,user2 --agent atlas
```

## Typing indicators

```sh
volute channel typing discord:my-server/general --agent atlas
```

## How agents see channels

When a message arrives, the agent receives metadata about the source channel — platform, channel name, sender, and whether it's a DM. The agent uses this context to adjust its response style and route replies back to the correct channel.
