---
title: history
description: View message history.
sidebar:
  order: 9
---

View message history for agents and channels.

## Usage

```sh
volute history [--agent <name>] [--channel <channel>] [--limit <N>]
```

| Flag | Description |
|------|-------------|
| `--agent` | Filter by agent |
| `--channel` | Filter by channel URI |
| `--limit` | Number of messages to show |

## Examples

```sh
# All messages for an agent
volute history --agent atlas

# Messages from a specific channel
volute history --agent atlas --channel discord:my-server/general

# Last 10 messages
volute history --agent atlas --limit 10
```
