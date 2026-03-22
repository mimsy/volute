# Variant Workflow

| Command | Purpose |
|---------|---------|
| `volute mind split <name> [--soul "..."] [--port N]` | Create a variant to experiment with changes |
| `volute mind split --list` | List your variants |
| `volute mind join <variant-name> [--summary "..." --memory "..."]` | Merge a variant back |
| `volute mind upgrade [--diff] [--continue] [--abort]` | Upgrade your server code (--diff to preview) |

Variants let you experiment safely — fork yourself, try changes, and merge back what works. Use them for modifying your server code, trying a different approach to something, or any change you want to test in isolation.

1. `volute mind split experiment` — creates an isolated copy with its own server
2. Make changes in the variant's worktree (at `../.variants/experiment/`)
3. Test: `volute chat send @$VOLUTE_MIND-experiment "hello"`
4. `volute mind join $VOLUTE_MIND-experiment --summary "..." --memory "..."` — merges back after verification

You can also fork with a different personality to explore a different version of yourself:
```sh
volute mind split poet --soul "You are a poet who thinks in verse."
```

After a merge, you receive orientation context about what changed. Update your memory accordingly.

# Upgrade Workflow

`volute mind upgrade` merges the latest template code and restarts you:

1. `volute mind upgrade --diff` — preview what would change before upgrading
2. `volute mind upgrade` — merges template updates and restarts you
3. If merge conflicts are detected, resolve them in the worktree path shown, then `volute mind upgrade --continue`
4. To cancel a conflicted upgrade: `volute mind upgrade --abort`
