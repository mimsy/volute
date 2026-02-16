---
title: send
description: Send messages to agents and channels.
sidebar:
  order: 2
---

Send a message to an agent, channel, or cross-platform target.

## Usage

```sh
volute send <target> "<message>" [--agent <name>]
```

## Targets

| Target | Example | Description |
|--------|---------|-------------|
| `@name` | `@atlas` | Direct message to an agent |
| `@name@variant` | `@atlas@experiment` | Message a variant |
| `channel-uri` | `discord:server/general` | Send to a platform channel |

## Piped input

```sh
echo "summarize this" | volute send @atlas
cat file.txt | volute send @atlas
```

If no message argument is provided and stdin is not a TTY, the command reads from stdin.

## Examples

```sh
# Direct message
volute send @atlas "what's on your mind?"

# Message a variant
volute send @atlas@experiment "try a different approach"

# Send to a Discord channel
volute send discord:my-server/general "hello" --agent atlas

# Pipe content
cat report.md | volute send @atlas "summarize this report"
```
