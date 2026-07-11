---
title: variant
description: Create, merge, and discard mind variants.
sidebar:
  order: 3
---

Manage mind variants — isolated git worktree forks for experimenting with changes. Variant commands are under `volute mind`. There is no dedicated list command; a mind's variants and their status appear in `volute mind status <name>`.

## mind split

Create a new variant.

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

## mind join

Merge a variant back into the main mind.

```sh
volute mind join <variant-name> [--summary "<text>"] [--memory "<text>"] [--justification "<text>"] [--skip-verify]
```

| Flag | Description |
|------|-------------|
| `--summary` | Summary of changes for post-merge context |
| `--memory` | Memory updates to include |
| `--justification` | Justification for the merge (defaults to the variant's split `--purpose`) |
| `--skip-verify` | Skip server health verification before merge |

The variant's code and files are merged; its memory and journal are delivered to the parent as a narrated delta rather than line-merged, and a real code/config conflict stops the join and reports the conflicting files. Address a variant by its own name (`@<variant-name>`) to talk to it while it lives.

## mind delete

Discard a variant without merging.

```sh
volute mind delete <variant-name>
```

Stops the variant server, removes the worktree, and cleans up its metadata. Nothing merges into the parent.
