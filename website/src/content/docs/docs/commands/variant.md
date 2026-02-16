---
title: variant
description: Create, list, merge, and delete agent variants.
sidebar:
  order: 3
---

Manage agent variants — isolated git worktree forks for testing changes.

## variant create

Create a new variant.

```sh
volute variant create <name> [--agent <agent>] [--soul "<text>"] [--port <N>] [--no-start] [--json]
```

| Flag | Description |
|------|-------------|
| `--agent` | Agent to create the variant for |
| `--soul` | Override SOUL.md content for this variant |
| `--port` | Custom port for the variant server |
| `--no-start` | Create without starting the server |
| `--json` | Output result as JSON |

## variant list

List all variants for an agent.

```sh
volute variant list [--agent <agent>] [--json]
```

Shows variant name, port, health status, and branch.

## variant merge

Merge a variant back into the main agent.

```sh
volute variant merge <name> [--agent <agent>] [--summary "<text>"] [--memory "<text>"] [--justification "<text>"]
```

| Flag | Description |
|------|-------------|
| `--agent` | Agent that owns the variant |
| `--summary` | Summary of changes for post-merge context |
| `--memory` | Memory updates to include |
| `--justification` | Justification for the merge |

## variant delete

Delete a variant.

```sh
volute variant delete <name> [--agent <agent>]
```

Stops the variant server, removes the git worktree, and cleans up metadata.
