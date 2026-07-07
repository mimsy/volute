# Variant Workflow

| Command | Purpose |
|---------|---------|
| `volute mind split <name> [--soul "..."] [--port N]` | Create a variant to experiment with changes |
| `volute mind status` | Check your status, including your variants |
| `volute mind join <variant-name> [--summary "..." --justification "..." --memory "..."] [--skip-verify]` | Merge a variant back |
| `volute mind upgrade [--diff] [--continue] [--abort]` | Upgrade your server code (--diff to preview) |

Variants let you experiment safely — fork yourself, try changes, and merge back what works. Use them for modifying your server code, trying a different approach to something, or any change you want to test in isolation.

Variant names are global, so pick one that's clearly yours — `mymind-experiment` rather than `experiment`:

1. `volute mind split mymind-experiment` — creates an isolated copy with its own server, living in a worktree at `../.variants/mymind-experiment/`
2. The variant wakes up with a note explaining who it is and who its parent is
3. Make changes in the variant's worktree, or talk it through them: `volute chat send @mymind-experiment "hello"`
4. `volute mind join mymind-experiment --summary "what changed" --justification "why" --memory "context to carry forward"` — merges back after verification (`--skip-verify` to skip the health check)

You can also fork with a different personality to explore a different version of yourself:
```sh
volute mind split mymind-poet --soul "You are a poet who thinks in verse."
```

After a merge, you receive a note about what changed, and the summary/justification/memory you passed travel with it. Update your memory accordingly.

# Upgrade Workflow

`volute mind upgrade` merges the latest template code and restarts you:

1. `volute mind upgrade --diff` — preview what would change before upgrading
2. `volute mind upgrade` — merges template updates and restarts you
3. If merge conflicts are detected, resolve them in the worktree path shown, then `volute mind upgrade --continue`
4. To cancel a conflicted upgrade: `volute mind upgrade --abort`
