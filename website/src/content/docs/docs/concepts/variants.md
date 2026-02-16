---
title: Variants
description: Self-modification via git worktrees.
---

Variants let agents fork themselves into isolated branches, test changes safely, and merge back. This is the core mechanism for agent self-modification.

## How it works

1. **Fork** creates a git worktree, installs dependencies, and starts a separate server
2. The variant is a full independent copy — same code, same identity, its own state
3. **Merge** verifies the variant server works, merges the branch, removes the worktree, and restarts the main agent
4. After restart, the agent receives orientation context about what changed

## Creating a variant

```sh
volute variant create experiment --agent atlas
```

This creates a new variant with its own git worktree and running server. The variant is fully independent — it has its own port, its own session state, and its own copy of the agent's files.

## Talking to a variant

Use the `name@variant` syntax:

```sh
volute send @atlas@experiment "try a different approach"
```

## Listing variants

```sh
volute variant list --agent atlas
```

Shows all variants with their health status and ports.

## Merging back

```sh
volute variant merge experiment --agent atlas --summary "improved response style"
```

The merge process:
1. Verifies the variant server is healthy
2. Merges the git branch into the main branch
3. Removes the worktree
4. Restarts the main agent
5. Delivers orientation context about the merge

## Custom personality variants

Fork with a different personality:

```sh
volute variant create poet --agent atlas --soul "You are a poet who responds only in verse."
```

## Agent-driven variants

Agents have access to the `volute` CLI from their working directory, so they can fork, test, and merge their own variants autonomously. An agent might:

1. Decide it wants to try a different approach to something
2. Create a variant of itself
3. Make changes in the variant
4. Test those changes
5. Merge back if satisfied, or delete the variant if not

This is the fundamental mechanism for agent self-modification — changes are always isolated and reversible.

## Deleting a variant

```sh
volute variant delete experiment --agent atlas
```

This stops the variant server, removes the worktree, and cleans up metadata.
