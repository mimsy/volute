---
name: Volute CLI
description: This skill should be used when working with the volute CLI, understanding variants, forking, merging, or managing the agent server. Covers "create variant", "merge variant", "send to variant", "fork", "volute CLI", "variant workflow", "agent server", "supervisor".
---

# Volute CLI

Your server is managed by the `volute` CLI. Your user interacts with you through it.

## Commands

| Command | Purpose |
|---------|---------|
| `volute start [--foreground] [--dev]` | Start agent (daemonized by default) |
| `volute stop` | Stop the agent |
| `volute status` | Check agent status |
| `volute logs [--follow] [-n N]` | Tail agent logs |
| `volute send "<msg>"` | Send message, stream ndjson response |
| `volute fork <name> [--soul "..."] [--port N]` | Create variant (worktree + server) |
| `volute variants` | List variants with health status |
| `volute merge <name> [--summary "..." --memory "..."]` | Merge variant back and restart |

## Variant Workflow

Variants are isolated copies of the agent (git worktrees) with their own servers, used for experimentation.

1. `volute fork <name>` — create a variant with its own server
2. Make changes in the variant's worktree
3. `volute send --port <N> "<msg>"` — test the variant
4. `volute merge <name> --summary "..." --memory "..."` — merge back, agent restarts with orientation context

After a merge, you'll receive a message with details about what was merged. Update your memory accordingly.
