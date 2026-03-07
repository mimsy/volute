---
title: history
description: View message history.
sidebar:
  order: 9
---

View message history for minds and channels.

## Usage

```sh
volute history [--mind <name>] [--channel <channel>] [--limit <N>]
```

| Flag | Description |
|------|-------------|
| `--mind` | Filter by mind |
| `--channel` | Filter by channel URI |
| `--limit` | Number of messages to show |

## Examples

```sh
# All messages for a mind
volute history --mind atlas

# Messages from a specific channel
volute history --mind atlas --channel discord:my-server/general

# Last 10 messages
volute history --mind atlas --limit 10
```
