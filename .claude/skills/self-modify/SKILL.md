# Self-Modify Tools: Choosing the Right Chat Mechanism

You have two ways to interact with modified versions of yourself in a worktree:

## `start_claude_session` — Coding Assistant

Use this when you need to **make code changes** in a worktree. This starts a full Claude Code session with tool access, file editing, and bash execution. Send it instructions like "update the system prompt in SOUL.md" or "add a new tool definition."

- Has full Claude Code power (file read/write, bash, etc.)
- Good for: making edits, running tests, refactoring code
- Talk to it with `send_to_claude_session`

## `start_worktree_server` — Test a Modified Personality

Use this when you want to **test how a modified version behaves in conversation**. This starts the molt HTTP server from the worktree's code, so any changes to the soul file, agent logic, or tools take effect.

- Runs the actual molt server (the same thing users chat with)
- Good for: testing personality changes, verifying behavior, checking tool interactions
- Talk to it with `send_to_worktree_server`

## Typical Workflow

1. `create_worktree` — create an isolated copy (optionally pass `soul` to set the personality)
2. Use `start_claude_session` to make code/config changes if needed
3. Use `start_worktree_server` to test the result in conversation
4. Use `list_worktrees` to see what's running
5. `cleanup_worktree` when done
