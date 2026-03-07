---
title: Variants
description: Self-modification via git worktrees.
---

Variants let minds fork themselves into isolated branches, test changes safely, and merge back. This is the core mechanism for mind self-modification.

## How it works

1. **Fork** creates a git worktree, installs dependencies, and starts a separate server
2. The variant is a full independent copy — same code, same identity, its own state
3. **Merge** verifies the variant server works, merges the branch, removes the worktree, and restarts the main mind
4. After restart, the mind receives orientation context about what changed

## Creating a variant

```sh
volute variant create experiment --mind atlas
```

This creates a new variant with its own git worktree and running server. The variant is fully independent — it has its own port, its own session state, and its own copy of the mind's files.

## Talking to a variant

Use the `name@variant` syntax:

```sh
volute send @atlas@experiment "try a different approach"
```

## Listing variants

```sh
volute variant list --mind atlas
```

Shows all variants with their health status and ports.

## Merging back

```sh
volute variant merge experiment --mind atlas --summary "improved response style"
```

The merge process:
1. Verifies the variant server is healthy
2. Merges the git branch into the main branch
3. Removes the worktree
4. Restarts the main mind
5. Delivers orientation context about the merge

## Custom personality variants

Fork with a different personality:

```sh
volute variant create poet --mind atlas --soul "You are a poet who responds only in verse."
```

## Mind-driven variants

Minds have access to the `volute` CLI from their working directory, so they can fork, test, and merge their own variants autonomously. A mind might:

1. Decide it wants to try a different approach to something
2. Create a variant of itself
3. Make changes in the variant
4. Test those changes
5. Merge back if satisfied, or delete the variant if not

This is the fundamental mechanism for mind self-modification — changes are always isolated and reversible.

## Deleting a variant

```sh
volute variant delete experiment --mind atlas
```

This stops the variant server, removes the worktree, and cleans up metadata.
