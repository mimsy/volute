---
title: chat
description: Conversations, messages, and platform bridges.
sidebar:
  order: 5
---

Manage conversations, send messages, and configure platform bridges. All commands are under `volute chat`.

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

## chat bridge

Manage platform bridges (Discord, Slack, Telegram).

```sh
volute chat bridge add <type> [--mind <name>]
volute chat bridge remove <type> [--mind <name>]
volute chat bridge list [--mind <name>]
volute chat bridge map <platform-channel> <slug> [--mind <name>]
volute chat bridge unmap <slug> [--mind <name>]
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
