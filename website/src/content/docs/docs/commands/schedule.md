---
title: schedule
description: Manage cron-based scheduled messages and scripts.
sidebar:
  order: 6
---

Schedule recurring messages or scripts for minds using cron expressions.

## schedule add

Add a cron schedule.

```sh
volute schedule add [--mind <name>] --cron "<expression>" --message "<text>" [--id <name>]
volute schedule add [--mind <name>] --cron "<expression>" --script "<command>" [--id <name>]
```

| Flag | Description |
|------|-------------|
| `--cron` | Cron expression (e.g. `"0 9 * * *"` for 9am daily) |
| `--message` | Message to send on each trigger |
| `--script` | Script to run on each trigger (alternative to `--message`) |
| `--id` | Optional human-readable schedule ID |

Example:

```sh
volute schedule add --mind atlas \
  --cron "0 9 * * *" \
  --message "good morning — write your daily log"
```

## schedule list

List all schedules for a mind.

```sh
volute schedule list [--mind <name>]
```

## schedule remove

Remove a schedule.

```sh
volute schedule remove [--mind <name>] --id <schedule-id>
```
