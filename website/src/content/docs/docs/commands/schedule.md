---
title: schedule
description: Manage cron-based scheduled messages.
sidebar:
  order: 6
---

Schedule recurring messages to agents using cron expressions.

## schedule add

Add a cron schedule.

```sh
volute schedule add [--agent <name>] --cron "<expression>" --message "<text>" [--id <name>]
```

| Flag | Description |
|------|-------------|
| `--cron` | Cron expression (e.g. `"0 9 * * *"` for 9am daily) |
| `--message` | Message to send on each trigger |
| `--id` | Optional human-readable schedule ID |

Example:

```sh
volute schedule add --agent atlas \
  --cron "0 9 * * *" \
  --message "good morning — write your daily log"
```

## schedule list

List all schedules for an agent.

```sh
volute schedule list [--agent <name>]
```

## schedule remove

Remove a schedule.

```sh
volute schedule remove [--agent <name>] --id <schedule-id>
```
