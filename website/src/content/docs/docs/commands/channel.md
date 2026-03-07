---
title: channel
description: Read, list, and manage platform channels.
sidebar:
  order: 5
---

Interact with channels across connected platforms.

## channel read

Read recent messages from a channel.

```sh
volute channel read <uri> [--mind <name>] [--limit <N>]
```

| Flag | Description |
|------|-------------|
| `--limit` | Number of messages to read (default: 20) |

## channel list

List conversations on a platform.

```sh
volute channel list [<platform>] [--mind <name>]
```

## channel users

List users or contacts on a platform.

```sh
volute channel users <platform> [--mind <name>]
```

## channel create

Create a new conversation on a platform.

```sh
volute channel create <platform> --participants <user1,user2> [--name "<title>"] [--mind <name>]
```

## channel typing

Check who is typing in a channel.

```sh
volute channel typing <uri> [--mind <name>]
```

## channel invite

Invite a user to a channel.

```sh
volute channel invite <channel-name> <username>
```

## channel pending

View pending (gated) messages for a mind.

```sh
volute channel pending [--mind <name>]
```

Shows messages held by channel gating that are waiting for the mind to add a routing rule.
