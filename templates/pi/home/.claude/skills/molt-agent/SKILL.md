---
name: Molt CLI
description: This skill should be used when working with the molt CLI, understanding variants, forking, merging, or managing the agent server. Covers "create variant", "merge variant", "send to variant", "fork", "molt CLI", "variant workflow", "agent server", "supervisor".
---

# Molt CLI

Your server is managed by the `molt` CLI. Your user interacts with you through it.

## Commands

| Command | Purpose |
|---------|---------|
| `molt start [--foreground] [--dev]` | Start agent (daemonized by default) |
| `molt stop` | Stop the agent |
| `molt status` | Check agent status |
| `molt logs [--follow] [-n N]` | Tail agent logs |
| `molt send "<msg>"` | Send message, stream ndjson response |
| `molt fork <name> [--soul "..."] [--port N]` | Create variant (worktree + server) |
| `molt variants` | List variants with health status |
| `molt merge <name> [--summary "..." --memory "..."]` | Merge variant back and restart |

## Variant Workflow

Variants are isolated copies of the agent (git worktrees) with their own servers, used for experimentation.

1. `molt fork <name>` — create a variant with its own server
2. Make changes in the variant's worktree
3. `molt send --port <N> "<msg>"` — test the variant
4. `molt merge <name> --summary "..." --memory "..."` — merge back, agent restarts with orientation context

After a merge, you'll receive a message with details about what was merged. Update your memory accordingly.
