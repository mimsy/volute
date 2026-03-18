---
title: schedule
description: Manage cron-based scheduled messages, scripts, and sleep/wake cycles.
sidebar:
  order: 6
---

Schedule recurring messages or scripts for minds using cron expressions, and manage sleep/wake cycles. All schedule commands are under `volute clock`.

## clock add

Add a cron schedule or one-time timer.

```sh
volute clock add [--mind <name>] --id <name> --cron "<expression>" --message "<text>"
volute clock add [--mind <name>] --id <name> --cron "<expression>" --script "<command>"
volute clock add [--mind <name>] --id <name> --in "<duration>" --message "<text>"
```

| Flag | Description |
|------|-------------|
| `--id` | Human-readable schedule ID |
| `--cron` | Cron expression (e.g. `"0 9 * * *"` for 9am daily) |
| `--in` | Duration for one-time timer (e.g. `"30m"`, `"2h"`) |
| `--message` | Message to send on each trigger |
| `--script` | Script to run on each trigger (alternative to `--message`) |
| `--channel` | Target channel for the message |
| `--session` | Session name to use |
| `--while-sleeping` | Behavior during sleep: `skip`, `queue`, or `trigger-wake` |

Example:

```sh
volute clock add --mind atlas \
  --id morning \
  --cron "0 9 * * *" \
  --message "good morning — write your daily log"
```

## clock list

List all schedules and timers for a mind.

```sh
volute clock list [--mind <name>]
```

## clock remove

Remove a schedule or timer.

```sh
volute clock remove [--mind <name>] --id <schedule-id>
```

## clock status

Show sleep state and upcoming schedule fires.

```sh
volute clock status [--mind <name>]
```

## clock sleep

Put a mind to sleep. See [sleep](/volute/docs/concepts/sleep/) for details.

```sh
volute clock sleep <name> [--wake-at <time>]
```

## clock wake

Wake a sleeping mind.

```sh
volute clock wake <name>
```
