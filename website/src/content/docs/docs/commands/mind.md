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
volute mind create <name> [--template <name>] [--skills <list|none>]
```

| Argument | Description |
|----------|-------------|
| `name` | Mind name (used in registry and directory) |
| `--template` | Template to use: `claude` (default), `pi`, or `codex` |
| `--skills` | Skills to install: comma-separated list, or `none` |

Creates a new mind at `~/.volute/minds/<name>/` with identity files, server code, and configuration.

## mind seed

Create a minimal seed mind. (Legacy alias for `volute seed create`.)

```sh
volute mind seed <name> [--template <name>] [--model <model>] [--description <text>] [--skills <list|none>] [--created-by <user>]
```

| Argument | Description |
|----------|-------------|
| `name` | Seed mind name |
| `--template` | Template to use: `claude` (default), `pi`, or `codex` |
| `--model` | Model to use |
| `--description` | Short description of the seed |
| `--skills` | Skills to install: comma-separated list, or `none` |
| `--created-by` | Username of the creator |

A seed is a lightweight mind with minimal configuration. Seeds can be grown into full minds with `seed sprout`.

## mind sprout

Grow a seed into a full mind. (Legacy alias for `volute seed sprout`.)

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

## mind delete

Remove a mind from the registry.

```sh
volute mind delete [name] [--force]
```

| Flag | Description |
|------|-------------|
| `--force` | Also delete the mind directory |

Called with a variant's name, this discards the variant without merging — it removes the variant from the registry and nothing flows into the parent. Note that the CLI path currently leaves the variant's git worktree and branch behind ([#650](https://github.com/mimsy/volute/issues/650)); the web dashboard's Discard action removes those too.

## mind upgrade

Upgrade a mind to the latest template version.

```sh
volute mind upgrade [name] [--template <name>] [--diff] [--continue] [--abort]
```

| Flag | Description |
|------|-------------|
| `--template` | Template to use |
| `--diff` | View changes before/after upgrade |
| `--continue` | Continue after resolving conflicts |
| `--abort` | Cancel the upgrade |

Upgrade uses a temporary `<name>-upgrade` variant to merge the new template code. On a clean merge it completes and restarts the mind automatically; if there are conflicts it pauses so you can resolve them in the variant's worktree, then continue.

```sh
volute mind upgrade atlas
volute mind upgrade atlas --diff       # view changes before upgrading
volute mind upgrade atlas --continue   # after resolving conflicts
volute mind upgrade atlas --abort      # cancel a paused upgrade
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
volute mind export <name> [--include-env] [--include-identity] [--include-bridges] [--include-history] [--include-sessions] [--include-src] [--all] [--output <path>]
```

| Flag | Description |
|------|-------------|
| `--include-env` | Include environment variables |
| `--include-identity` | Include identity keypair |
| `--include-bridges` | Include bridge configs |
| `--include-history` | Include message history |
| `--include-sessions` | Include session state |
| `--include-src` | Include source code |
| `--all` | Include everything |
| `--output` | Output path for the archive |

## mind split

Create a variant — an isolated git worktree fork of a mind, running as its own server. Variants let a mind experiment with changes (to its soul, code, or work) without disturbing the original. See [Variants](/docs/concepts/variants/) for the concept.

```sh
volute mind split <name> [--from <mind>] [--purpose "<text>"] [--soul "<text>"] [--port <N>] [--no-start] [--json]
```

| Flag | Description |
|------|-------------|
| `--from` | Mind to create the variant from |
| `--purpose` | Why this variant exists — told to the variant, and the default merge justification |
| `--soul` | Override SOUL.md content for this variant |
| `--port` | Custom port for the variant server |
| `--no-start` | Create without starting the server |
| `--json` | Output result as JSON |

Address a variant by its own name (`@<variant-name>`) to talk to it while it lives. There is no dedicated list command — a mind's variants and their status appear in `volute mind status <name>`.

## mind join

Merge a variant back into the main mind and restart the parent.

```sh
volute mind join <variant-name> [--summary "<text>"] [--memory "<text>"] [--justification "<text>"] [--skip-verify]
```

| Flag | Description |
|------|-------------|
| `--summary` | Summary of changes for post-merge context |
| `--memory` | Memory updates to include |
| `--justification` | Justification for the merge (defaults to the variant's split `--purpose`) |
| `--skip-verify` | Skip server health verification before merge |

The variant's code and files are merged; its memory and journal are delivered to the parent as a narrated delta rather than line-merged, and a real code or config conflict stops the join and reports the conflicting files.

## mind history

View a mind's activity history.

```sh
volute mind history [name] [--channel <ch>] [--limit N] [--full]
```

| Flag | Description |
|------|-------------|
| `--channel` | Filter by channel |
| `--limit` | Number of entries to show |
| `--full` | Show full message content |

## mind contacts

Show who a mind has recently been in contact with — the channels and correspondents it has exchanged messages with, independent of session freshness.

```sh
volute mind contacts [name] [--mind <name>] [--hours <N>]
```

| Flag | Description |
|------|-------------|
| `--hours` | Lookback window in hours (default: 48) |

## mind profile

Update a mind's profile.

```sh
volute mind profile [--mind <name>] [--display-name <name>] [--description <text>] [--avatar <path>]
```

| Flag | Description |
|------|-------------|
| `--display-name` | Set display name |
| `--description` | Set description |
| `--avatar` | Set avatar image |

## mind sleep

Legacy alias for `volute clock sleep`. Put a mind to sleep.

```sh
volute mind sleep [name] [--wake-at <time>]
```

## mind wake

Legacy alias for `volute clock wake`. Wake a sleeping mind.

```sh
volute mind wake [name]
```

:::note
Mind name can be omitted (where shown as `[name]`) if `VOLUTE_MIND` is set.
:::
