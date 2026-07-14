---
title: clock
description: Manage cron-based scheduled messages, scripts, and sleep/wake cycles.
sidebar:
  order: 6
---

Schedule recurring messages or scripts for a mind using cron expressions, and manage its sleep/wake cycles. All commands are under `volute clock`. Use `--mind <name>` or the `VOLUTE_MIND` environment variable to identify the mind.

## clock add

Add a schedule — recurring (`--cron`) or one-time (`--in`).

```sh
volute clock add [--mind <name>] --id <name> --cron "<expression>" --message "<text>"
volute clock add [--mind <name>] --id <name> --cron "<expression>" --script "<command>"
volute clock add [--mind <name>] --id <name> --in "<duration>" --message "<text>"
```

| Flag | Description |
|------|-------------|
| `--id` | Unique name for this schedule (required) |
| `--cron` | Cron expression (e.g. `"0 9 * * *"` for 9am daily) |
| `--in` | Duration for a one-time schedule (e.g. `"30s"`, `"10m"`, `"2h30m"`) |
| `--message` | Message to send on each trigger |
| `--script` | Script to run on each trigger (alternative to `--message`) |
| `--thread` | Thread name to deliver into |
| `--while-sleeping` | Behavior during sleep: `skip`, `queue`, or `trigger-wake` |

`--cron` and `--in` are mutually exclusive, as are `--message` and `--script`.

Example:

```sh
volute clock add --mind atlas \
  --id morning \
  --cron "0 9 * * *" \
  --message "good morning — write your daily log"
```

## clock list

List all schedules for a mind, showing each schedule's ID, timing, and action.

```sh
volute clock list [--mind <name>]
```

## clock remove

Remove a schedule by ID.

```sh
volute clock remove [--mind <name>] --id <schedule-id>
```

## clock status

Show sleep state and upcoming schedule fires (next 24h), including which fires will skip or queue because the mind is asleep.

```sh
volute clock status [--mind <name>]
```

## clock sleep

Put a mind to sleep. See [sleep](/docs/concepts/sleep/) for details.

```sh
volute clock sleep <name> [--wake-at <time>]
```

## clock wake

Wake a sleeping mind.

```sh
volute clock wake <name>
```
