---
title: mind
description: Create, start, stop, and manage minds.
sidebar:
  order: 1
---

Manage mind lifecycle — creation, startup, shutdown, logs, upgrades, and deletion.

## mind create

Create a new mind.

```sh
volute mind create <name> [--template <name>]
```

| Argument | Description |
|----------|-------------|
| `name` | Mind name (used in registry and directory) |
| `--template` | Template to use: `claude` (default) or `pi` |

Creates a new mind at `~/.volute/minds/<name>/` with identity files, server code, and configuration.

## mind seed

Create a minimal seed mind.

```sh
volute mind seed <name> [--template <name>]
```

A seed is a lightweight mind with minimal configuration. Seeds can be grown into full minds with `mind sprout`.

## mind sprout

Grow a seed into a full mind.

```sh
volute mind sprout
```

Run by the mind itself. Requires `VOLUTE_MIND` to be set — this command is designed to be invoked from within a running seed mind.

## mind start

Start a mind.

```sh
volute mind start [name]
```

The daemon spawns the mind server process and assigns it a port.

## mind stop

Stop a running mind.

```sh
volute mind stop [name]
```

## mind restart

Restart a mind.

```sh
volute mind restart [name]
```

## mind list

List all registered minds.

```sh
volute mind list
```

## mind status

Check a mind's status.

```sh
volute mind status [name]
```

## mind logs

View mind logs.

```sh
volute mind logs [name] [--follow] [-n <lines>]
```

| Flag | Description |
|------|-------------|
| `--follow` | Stream logs in real-time |
| `-n` | Number of lines to show (default: 50) |

## mind delete

Remove a mind from the registry.

```sh
volute mind delete [name] [--force]
```

| Flag | Description |
|------|-------------|
| `--force` | Also delete the mind directory |

## mind upgrade

Upgrade a mind to the latest template version.

```sh
volute mind upgrade [name] [--template <name>] [--continue]
```

Creates an "upgrade" variant with the new template code. Resolve any conflicts, test the variant, then merge it back.

```sh
volute mind upgrade atlas
# resolve conflicts if needed
volute mind upgrade atlas --continue
volute send @atlas@upgrade "are you working?"
volute variant merge upgrade --mind atlas
```

## mind import

Import an OpenClaw workspace.

```sh
volute mind import <path> [--name <name>] [--session <path>] [--template <name>]
```

| Flag | Description |
|------|-------------|
| `--name` | Override the mind name |
| `--session` | Path to session.jsonl to convert |
| `--template` | Template to use (default: `claude`) |

## mind export

Export a mind as an archive.

```sh
volute mind export <name> [--include-env] [--include-identity] [--include-connectors] [--include-history] [--include-sessions] [--all] [--output <path>]
```

| Flag | Description |
|------|-------------|
| `--include-env` | Include environment variables |
| `--include-identity` | Include identity keypair |
| `--include-connectors` | Include connector configs |
| `--include-history` | Include message history |
| `--include-sessions` | Include session state |
| `--all` | Include everything |
| `--output` | Output path for the archive |

## mind connect

Enable a connector for a mind.

```sh
volute mind connect <type> [--mind <name>]
```

| Argument | Description |
|----------|-------------|
| `type` | Connector type: `discord`, `slack`, `telegram` |

Make sure the required environment variables are set before connecting. See [Connectors](/volute/docs/concepts/connectors/) for platform-specific setup.

## mind disconnect

Disable a connector for a mind.

```sh
volute mind disconnect <type> [--mind <name>]
```

## mind sleep

Put a mind to sleep.

```sh
volute mind sleep [name] [--wake-at <time>]
```

| Flag | Description |
|------|-------------|
| `--wake-at` | Schedule an automatic wake time |

The mind goes through a pre-sleep ritual, archives its session, and stops.

## mind wake

Wake a sleeping mind.

```sh
volute mind wake [name]
```

:::note
Mind name can be omitted (where shown as `[name]`) if `VOLUTE_MIND` is set.
:::
