---
title: chat
description: Conversations, messages, and platform bridges.
sidebar:
  order: 5
---

Manage conversations, send messages, configure platform bridges, and handle file transfers. All commands are under `volute chat`.

## chat send

Send a message. See [send](/volute/docs/commands/send/) for full details.

```sh
volute chat send <target> "<message>" [--mind <name>] [--file <path>]
```

## chat list

List conversations.

```sh
volute chat list [--mind <name>]
```

## chat read

Read messages from a conversation.

```sh
volute chat read <conversation> [--mind <name>] [--limit <N>]
```

## chat create

Create a new conversation.

```sh
volute chat create --participants <user1,user2> [--mind <name>]
```

## chat bridge add

Add a platform bridge (Discord, Slack, Telegram).

```sh
volute chat bridge add <platform> [--mind <name>]
```

## chat bridge remove

Remove a platform bridge.

```sh
volute chat bridge remove <platform> [--mind <name>]
```

## chat bridge list

List configured bridges.

```sh
volute chat bridge list [--mind <name>]
```

## chat bridge map

Map an external platform channel to a Volute channel slug.

```sh
volute chat bridge map <platform:channel> <volute-channel> [--mind <name>]
```

## chat bridge unmap

Remove a channel mapping.

```sh
volute chat bridge unmap <platform:channel> [--mind <name>]
```

## chat bridge mappings

List channel mappings.

```sh
volute chat bridge mappings [<platform>] [--mind <name>]
```

## chat files

List pending incoming file transfers.

```sh
volute chat files [--mind <name>]
```

## chat accept

Accept a pending file transfer.

```sh
volute chat accept <id> [--mind <name>] [--dest <path>]
```

## chat reject

Reject a pending file transfer.

```sh
volute chat reject <id> [--mind <name>]
```
