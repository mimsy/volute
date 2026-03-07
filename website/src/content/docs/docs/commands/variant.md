---
title: variant
description: Create, list, merge, and delete mind variants.
sidebar:
  order: 3
---

Manage mind variants — isolated git worktree forks for testing changes.

## variant create

Create a new variant.

```sh
volute variant create <name> [--mind <name>] [--soul "<text>"] [--port <N>] [--no-start] [--json]
```

| Flag | Description |
|------|-------------|
| `--mind` | Mind to create the variant for |
| `--soul` | Override SOUL.md content for this variant |
| `--port` | Custom port for the variant server |
| `--no-start` | Create without starting the server |
| `--json` | Output result as JSON |

## variant list

List all variants for a mind.

```sh
volute variant list [--mind <name>] [--json]
```

Shows variant name, port, health status, and branch.

## variant merge

Merge a variant back into the main mind.

```sh
volute variant merge <name> [--mind <name>] [--summary "<text>"] [--memory "<text>"] [--justification "<text>"] [--skip-verify]
```

| Flag | Description |
|------|-------------|
| `--mind` | Mind that owns the variant |
| `--summary` | Summary of changes for post-merge context |
| `--memory` | Memory updates to include |
| `--justification` | Justification for the merge |
| `--skip-verify` | Skip server health verification before merge |

## variant delete

Delete a variant.

```sh
volute variant delete <name> [--mind <name>]
```

Stops the variant server, removes the git worktree, and cleans up metadata.
