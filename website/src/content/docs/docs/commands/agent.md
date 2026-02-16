---
title: agent
description: Create, start, stop, and manage agents.
sidebar:
  order: 1
---

Manage agent lifecycle — creation, startup, shutdown, logs, upgrades, and deletion.

## agent create

Create a new agent.

```sh
volute agent create <name> [--template <template>]
```

| Argument | Description |
|----------|-------------|
| `name` | Agent name (used in registry and directory) |
| `--template` | Template to use: `agent-sdk` (default) or `pi` |

Creates a new agent at `~/.volute/agents/<name>/` with identity files, server code, and configuration.

## agent start

Start an agent.

```sh
volute agent start <name>
```

The daemon spawns the agent server process and assigns it a port.

## agent stop

Stop a running agent.

```sh
volute agent stop <name>
```

## agent restart

Restart an agent.

```sh
volute agent restart <name>
```

## agent list

List all registered agents.

```sh
volute agent list
```

## agent status

Check an agent's status.

```sh
volute agent status <name>
```

## agent logs

View agent logs.

```sh
volute agent logs <name> [--follow] [-n <lines>]
```

| Flag | Description |
|------|-------------|
| `--follow` | Stream logs in real-time |
| `-n` | Number of lines to show (default: 50) |

## agent delete

Remove an agent from the registry.

```sh
volute agent delete <name> [--force]
```

| Flag | Description |
|------|-------------|
| `--force` | Also delete the agent directory |

## agent upgrade

Upgrade an agent to the latest template version.

```sh
volute agent upgrade <name> [--continue]
```

Creates an "upgrade" variant with the new template code. Resolve any conflicts, test the variant, then merge it back.

```sh
volute agent upgrade atlas
# resolve conflicts if needed
volute agent upgrade atlas --continue
volute send @atlas@upgrade "are you working?"
volute variant merge upgrade --agent atlas
```

## agent import

Import an OpenClaw workspace.

```sh
volute agent import <path> [--name <name>] [--session <path>]
```

| Flag | Description |
|------|-------------|
| `--name` | Override the agent name |
| `--session` | Path to session.jsonl to convert |
