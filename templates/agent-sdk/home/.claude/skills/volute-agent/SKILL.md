---
name: Volute CLI
description: This skill should be used when working with the volute CLI, understanding variants, forking, merging, or managing the agent server. Covers "create variant", "merge variant", "send to variant", "fork", "volute CLI", "variant workflow", "agent server", "supervisor", "channel", "discord", "send message", "read messages".
---

# Self-Management

You manage yourself through the `volute` CLI. Use `$VOLUTE_AGENT` for your own name in commands.

## Commands

| Command | Purpose |
|---------|---------|
| `volute status` | Check your status |
| `volute logs [--follow] [-n N]` | Read your own logs |
| `volute fork <name> [--soul "..."] [--port N]` | Create a variant for testing changes |
| `volute variants` | List your variants |
| `volute merge <name> [--summary "..." --memory "..."]` | Merge a variant back |
| `volute upgrade [--template <name>] [--continue]` | Upgrade your server code |
| `volute channel read discord:<id> [--limit N]` | Read channel history |
| `volute channel send discord:<id> "<msg>"` | Send a message proactively |

## Identity File Editing

Your identity files (`SOUL.md`, `MEMORY.md`, `VOLUTE.md`) are in your working directory. Edit them directly — changes trigger an automatic restart so they take effect in your system prompt. Your session resumes seamlessly.

## Variant Workflow

For changes to your server code (`src/`), use variants to test safely:

1. `volute fork experiment` — creates an isolated copy with its own server
2. Make changes in the variant's worktree (at `../.worktrees/experiment/`)
3. Test: `volute send $VOLUTE_AGENT@experiment "hello"`
4. `volute merge experiment --summary "..." --memory "..."` — merges back after verification

After a merge, you receive orientation context about what changed. Update your memory accordingly.

## Upgrade Workflow

`volute upgrade` merges the latest template code into a testable variant:

1. `volute upgrade` — creates an `upgrade` variant
2. Resolve any merge conflicts if prompted, then `volute upgrade --continue`
3. Test: `volute send $VOLUTE_AGENT@upgrade "hello"`
4. `volute merge upgrade` — merge back

## Git Introspection

Your cwd is `home/`, so use `git -C ..` for project-level operations:

- `git -C .. log --oneline -10` — recent project history
- `git -C .. diff` — current changes
- `git log -- MEMORY.md` — history of your memory changes
