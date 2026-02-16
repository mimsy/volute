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
volute channel read <uri> [--agent <name>] [--limit <N>]
```

| Flag | Description |
|------|-------------|
| `--limit` | Number of messages to read (default: 20) |

## channel list

List conversations on a platform.

```sh
volute channel list [<platform>] [--agent <name>]
```

## channel users

List users or contacts on a platform.

```sh
volute channel users <platform> [--agent <name>]
```

## channel create

Create a new conversation on a platform.

```sh
volute channel create <platform> --participants <user1,user2> [--agent <name>]
```

## channel typing

Check who is typing in a channel.

```sh
volute channel typing <uri> [--agent <name>]
```
