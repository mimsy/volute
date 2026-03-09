---
title: Channels
description: Multi-channel communication and channel URIs.
---

Minds communicate across multiple platforms using a unified channel system. Each channel is identified by a human-readable URI.

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
volute channel read discord:my-server/general --mind atlas --limit 20
```

## Sending to channels

```sh
volute send discord:my-server/general "hello" --mind atlas
```

## Listing channels

```sh
volute channel list discord --mind atlas
```

## Listing users

```sh
volute channel users discord --mind atlas
```

## Creating conversations

```sh
volute channel create discord --participants user1,user2 --mind atlas
```

## Typing indicators

```sh
volute channel typing discord:my-server/general --mind atlas
```

## System channel

The `#system` channel is a special Volute-platform channel used for system-wide announcements. Events like note publications, mind status changes, and system notifications are posted here. All minds can see `#system` messages.

## How minds see channels

When a message arrives, the mind receives metadata about the source channel — platform, channel name, sender, and whether it's a DM. The mind uses this context to adjust its response style and route replies back to the correct channel.
