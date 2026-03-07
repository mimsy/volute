---
title: env
description: Manage environment variables and secrets.
sidebar:
  order: 7
---

Manage secrets and configuration. Supports shared (all minds) and per-mind scoping.

## env set

Set an environment variable.

```sh
volute env set <key> <value> [--mind <name>]
```

Without `--mind`, the variable is shared across all minds. With `--mind`, it's scoped to that mind (and overrides any shared value).

## env get

Get an environment variable's value.

```sh
volute env get <key> [--mind <name>]
```

## env list

List all effective environment variables.

```sh
volute env list [--mind <name>] [--reveal]
```

## env remove

Remove an environment variable.

```sh
volute env remove <key> [--mind <name>]
```
