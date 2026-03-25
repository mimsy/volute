---
title: seed
description: Create and manage seed minds.
sidebar:
  order: 3
---

Seed minds are lightweight starting points that grow into full minds through an orientation process.

## seed create

Plant a new seed mind.

```sh
volute seed create <name> [--template <name>] [--model <model>] [--description <text>] [--skills <list|none>] [--created-by <user>]
```

| Argument | Description |
|----------|-------------|
| `name` | Seed mind name |
| `--template` | Template to use: `claude` (default), `pi`, or `codex` |
| `--model` | Model to use |
| `--description` | Short description of the seed |
| `--skills` | Skills to install: comma-separated list, or `none` |
| `--created-by` | Username of the creator |

A seed starts with minimal configuration. The spirit's nurture schedule periodically checks readiness and encourages the seed to develop its identity.

## seed sprout

Complete orientation and become a full mind.

```sh
volute seed sprout
```

Run by the seed itself. Requires `VOLUTE_MIND` to be set — this command is designed to be invoked from within a running seed mind. Checks that the seed has completed its orientation (SOUL.md, MEMORY.md, display name, avatar) before promoting to a full mind.

## seed check

Check seed readiness.

```sh
volute seed check <name>
```

Reports whether the seed has completed the required orientation steps: SOUL.md, MEMORY.md, display name, and avatar. Used by the spirit's nurture schedule to monitor seed progress.
