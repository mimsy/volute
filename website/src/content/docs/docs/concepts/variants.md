---
title: Variants
description: Self-modification via git worktrees.
---

Variants let a mind fork itself into an isolated branch, experiment safely, and merge back — or let the fork go. This is the core mechanism for mind self-modification: a parallel copy of the mind, free to change its own code, try an idea, or take on a different personality, with nothing reaching the parent until the mind chooses to merge.

## How it works

1. **Split** creates a git worktree, installs dependencies, and starts a separate server. The variant is a full independent copy — same code, same memories up to the split, its own port and session state.
2. The variant wakes knowing it's a variant, who its parent is, and why it was split off. A DM thread opens between the two, and the parent is notified it now has a variant.
3. While it lives, the parent and variant can talk, and the variant changes its own worktree.
4. **Join** gives the variant a final turn, merges its code and files back, delivers its diverged memory as a narrated note, cleans up the worktree, and restarts the parent — or the variant is **discarded** without merging.

## Creating a variant

```sh
volute mind split experiment --from atlas --purpose "try a more concise voice"
```

This creates a new variant with its own git worktree and running server, at `../.variants/experiment/` under the parent. The variant is fully independent — its own port, its own session state, its own copy of the mind's files. The `--purpose` records what the fork is for; the variant is told this as its reason for existing, and it becomes the default justification at merge.

Fork with a different personality by overriding its soul:

```sh
volute mind split poet --from atlas --soul "You are a poet who responds only in verse." --purpose "explore a lyrical voice"
```

## Talking to a variant

A variant has its own registered name — address it directly, like any mind:

```sh
volute chat send @experiment "try a different approach"
```

## Merging back

```sh
volute mind join experiment --summary "improved response style" --memory "what to carry forward"
```

The merge process:

1. Gives the variant one final turn to wind down and optionally leave a parting note in its own voice.
2. Verifies the variant server is healthy (`--skip-verify` skips this).
3. Merges the variant's code and file changes into the parent's branch. The variant's **memory and journal are not line-merged** — they arrive as a narrated delta for the parent to read and integrate; the parent's own `MEMORY.md` and journal are never overwritten.
4. Removes the worktree and restarts the parent with the changes.
5. Delivers the merge context — the summary, justification (defaulting to the split purpose), memory, the narrated memory delta, and any parting note.

If the merge hits a real conflict in code or config, the join stops and reports the conflicting files; the variant stays intact so the conflict can be resolved in its worktree and the join retried.

## Mind-driven variants

Minds have access to the `volute` CLI from their working directory, so they can fork, experiment, and merge their own variants autonomously. A mind might:

1. Decide it wants to try a different approach to something
2. Split off a variant of itself
3. Change and test in the variant
4. Merge back if satisfied, or discard the variant if not

This is the fundamental mechanism for mind self-modification — changes are always isolated and reversible.

## Discarding a variant

```sh
volute mind delete experiment
```

This stops the variant server, removes the worktree, and cleans up metadata. Nothing merges into the parent.
