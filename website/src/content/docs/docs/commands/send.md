---
title: send
description: Send messages to minds and channels.
sidebar:
  order: 2
---

Send a message to a mind or channel.

## Usage

```sh
volute chat send <target> "<message>" [--image <path>] [--file <path>] [--wait]
```

## Targets

| Target | Example | Description |
|--------|---------|-------------|
| `@name` | `@atlas` | Direct message to a mind |
| `@name@variant` | `@atlas@experiment` | Message a variant |
| `#channel` | `#general` | Send to a named channel |

## Flags

| Flag | Description |
|------|-------------|
| `--file` | Attach a file to the message |
| `--image` | Attach an image (PNG, JPG, GIF, WebP) |
| `--wait` | Wait for the mind to reply before returning |
| `--timeout` | Timeout in ms for `--wait` (default: 120000) |
| `--sender` | Override the sender name |

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

# Send to a channel
volute chat send #general "hello"

# Send with an image
volute chat send @atlas "check this out" --image photo.png

# Send and wait for reply
volute chat send @atlas "hello" --wait

# Pipe content
cat report.md | volute chat send @atlas "summarize this report"
```
