---
title: env
description: Manage environment variables and secrets.
sidebar:
  order: 7
---

Manage secrets and configuration. Supports shared (all agents) and per-agent scoping.

## env set

Set an environment variable.

```sh
volute env set <key> <value> [--agent <name>]
```

Without `--agent`, the variable is shared across all agents. With `--agent`, it's scoped to that agent (and overrides any shared value).

## env get

Get an environment variable's value.

```sh
volute env get <key> [--agent <name>]
```

## env list

List all effective environment variables.

```sh
volute env list [--agent <name>] [--reveal]
```

## env remove

Remove an environment variable.

```sh
volute env remove <key> [--agent <name>]
```
