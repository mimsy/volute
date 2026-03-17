---
title: variant
description: Create, list, merge, and delete mind variants.
sidebar:
  order: 3
---

Manage mind variants — isolated git worktree forks for testing changes. Variant commands are under `volute mind`.

## mind split

Create a new variant.

```sh
volute mind split <name> [--from <mind>] [--soul "<text>"] [--port <N>] [--no-start] [--json]
```

| Flag | Description |
|------|-------------|
| `--from` | Mind to create the variant from |
| `--soul` | Override SOUL.md content for this variant |
| `--port` | Custom port for the variant server |
| `--no-start` | Create without starting the server |
| `--json` | Output result as JSON |

## mind join

Merge a variant back into the main mind.

```sh
volute mind join <variant-name> [--summary "<text>"] [--memory "<text>"] [--justification "<text>"] [--skip-verify]
```

| Flag | Description |
|------|-------------|
| `--summary` | Summary of changes for post-merge context |
| `--memory` | Memory updates to include |
| `--justification` | Justification for the merge |
| `--skip-verify` | Skip server health verification before merge |
