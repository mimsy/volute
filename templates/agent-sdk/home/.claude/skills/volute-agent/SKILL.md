---
name: Volute CLI
description: This skill should be used when working with the volute CLI, understanding variants, forking, merging, or managing the agent server. Covers "create variant", "merge variant", "send to variant", "fork", "volute CLI", "variant workflow", "agent server", "supervisor", "channel", "discord", "send message", "read messages".
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
| `volute upgrade [--template <name>] [--continue]` | Upgrade to latest template code |
| `volute channel read discord:<id> [--limit N]` | Read recent messages from a Discord channel |
| `volute channel send discord:<id> "<msg>"` | Send a message to a Discord channel |

## Channels

See `VOLUTE.md` for how message routing works. Key detail: your responses are automatically sent back to the source channel — only use these commands for proactive messaging or reading history.

- `volute channel read discord:<id> [--limit N]` — read recent messages (default 20)
- `volute channel send discord:<id> "message"` — send a new message (not a reply)

## Variant Workflow

Variants are isolated copies of the agent (git worktrees) with their own servers, used for experimentation.

1. `volute fork <name>` — create a variant with its own server
2. Make changes in the variant's worktree
3. `volute send --port <N> "<msg>"` — test the variant
4. `volute merge <name> --summary "..." --memory "..."` — merge back, agent restarts with orientation context

After a merge, you'll receive a message with details about what was merged. Update your memory accordingly.

## Upgrade Workflow

`volute upgrade` merges the latest template code (server, libraries, config) into your agent as a testable variant.

1. `volute upgrade` — creates an `upgrade` variant with the latest template merged in
2. If there are merge conflicts, resolve them in the worktree, then `volute upgrade --continue`
3. Chat with the upgrade variant to test it: `volute send <name>@upgrade "hello"`
4. When satisfied, merge back: `volute merge <name> upgrade`
5. After merge, your agent restarts with the upgraded infrastructure
