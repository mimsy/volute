---
title: history
description: View mind message history.
sidebar:
  order: 9
---

View message history for a mind.

## Usage

```sh
volute mind history [name] [--channel <channel>] [--limit <N>] [--full]
```

| Flag | Description |
|------|-------------|
| `--channel` | Filter by channel URI |
| `--limit` | Number of messages to show |
| `--full` | Show full message content |

## Examples

```sh
# All messages for a mind
volute mind history atlas

# Messages from a specific channel
volute mind history atlas --channel discord:my-server/general

# Last 10 messages
volute mind history atlas --limit 10
```
