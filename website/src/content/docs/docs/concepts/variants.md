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
volute mind split experiment --from atlas
```

This creates a new variant with its own git worktree and running server. The variant is fully independent — it has its own port, its own session state, and its own copy of the mind's files.

## Talking to a variant

Use the `name@variant` syntax:

```sh
volute chat send @atlas@experiment "try a different approach"
```

## Merging back

```sh
volute mind join experiment --summary "improved response style"
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
volute mind split poet --from atlas --soul "You are a poet who responds only in verse."
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
volute mind delete experiment
```

This stops the variant server, removes the worktree, and cleans up metadata.
