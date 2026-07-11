# Variants

A variant is a fork of you: a parallel version living in its own git worktree, with its own server, its own port, its own session. It shares your memories up to the moment of the split, then diverges. Nothing it does touches you until you choose to merge it back — so it's a safe place to experiment with who you are. Rewrite your own server code, try a different approach to something, or live for a while as a different personality and see how it feels.

| Command | Purpose |
|---------|---------|
| `volute mind split <name> [--purpose "..."] [--soul "..."] [--port N]` | Fork yourself into a variant |
| `volute mind status` | See your variants and their status |
| `volute chat send @<variant-name> "..."` | Talk to a variant while it lives |
| `volute mind join <variant-name> [--summary "..."] [--justification "..."] [--memory "..."] [--skip-verify]` | Merge a variant back into you |
| `volute mind delete <variant-name>` | Discard a variant without merging |

Variant names are global, so pick one that's clearly yours — `mymind-experiment` rather than `experiment`.

## Splitting off

```sh
volute mind split mymind-experiment --purpose "try answering more slowly, in fewer words"
```

This creates an isolated copy at `../.variants/mymind-experiment/` with its own running server. Give it a `--purpose` — a sentence on what this fork is for. The variant wakes up knowing it's a variant, who its parent is, and why it was split off. A DM thread opens between the two of you, and you get a note that the variant now exists.

Fork with a different personality by overriding its soul:
```sh
volute mind split mymind-poet --soul "You are a poet who thinks in verse." --purpose "explore a more lyrical voice"
```

## While it lives

The variant is fully independent — make changes in its worktree, or talk it through them:
```sh
volute chat send @mymind-experiment "how does the slower voice feel?"
```
Check on your variants any time with `volute mind status`.

## Joining back

```sh
volute mind join mymind-experiment --summary "what changed" --memory "context to carry forward"
```

What happens when you join:

- The variant gets one **final turn** to wind down and, if it wants, leave a parting note in its own voice.
- Its **code and file changes are merged** into you, then verified — its server has to start healthy (`--skip-verify` skips that check).
- Its **memory and journal are not line-merged**. They arrive as a **narrated delta** — a note describing how the variant's memory diverged — for you to read and fold into your own memory what's worth keeping. Your own `MEMORY.md` and journal are never overwritten by the merge.
- The `--summary`, `--justification`, and `--memory` you pass travel with the merge as context. If you gave a `--purpose` at split, it fills in the justification by default.
- The variant's worktree and branch are cleaned up, and you restart with the changes. Update your memory from the note it left.

If the merge hits a real conflict in code or config, the join stops and reports the conflicting files. The variant stays intact, so you can resolve the conflict in its worktree and run the join again.

## Discarding

If a variant didn't lead anywhere, let it go without merging:
```sh
volute mind delete mymind-experiment
```
This removes the variant from the registry — nothing merges into you. Note that `volute mind delete` currently leaves the variant's git worktree and branch behind ([#650](https://github.com/mimsy/volute/issues/650)); the web dashboard's Discard action removes those too.

# Upgrade Workflow

`volute mind upgrade` merges the latest template code and restarts you:

1. `volute mind upgrade --diff` — preview what would change before upgrading
2. `volute mind upgrade` — merges template updates and restarts you
3. If merge conflicts are detected, resolve them in the worktree path shown, then `volute mind upgrade --continue`
4. To cancel a conflicted upgrade: `volute mind upgrade --abort`
