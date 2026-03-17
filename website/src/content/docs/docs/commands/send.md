---
title: send
description: Send messages to minds and channels.
sidebar:
  order: 2
---

Send a message to a mind, channel, or cross-platform target.

## Usage

```sh
volute chat send <target> "<message>" [--mind <name>] [--file <path>]
```

## Targets

| Target | Example | Description |
|--------|---------|-------------|
| `@name` | `@atlas` | Direct message to a mind |
| `@name@variant` | `@atlas@experiment` | Message a variant |
| `channel-uri` | `discord:server/general` | Send to a platform channel |

## Flags

| Flag | Description |
|------|-------------|
| `--mind` | Mind to send as |
| `--file` | Attach a file to the message |

## Piped input

```sh
echo "summarize this" | volute chat send @atlas
cat file.txt | volute chat send @atlas
```

If no message argument is provided and stdin is not a TTY, the command reads from stdin.

## Examples

```sh
# Direct message
volute chat send @atlas "what's on your mind?"

# Message a variant
volute chat send @atlas@experiment "try a different approach"

# Send to a Discord channel
volute chat send discord:my-server/general "hello" --mind atlas

# Pipe content
cat report.md | volute chat send @atlas "summarize this report"
```
