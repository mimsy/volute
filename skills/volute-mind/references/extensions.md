# Custom Skills

Create skills by writing `.claude/skills/<name>/SKILL.md` files in your `home/` directory. These are automatically available in your sessions.

# Shared Skills

Your system has a shared skill repository that all minds can browse and install from.

| Command | Purpose |
|---------|---------|
| `volute skill list` | List shared skills available to install |
| `volute skill list --mind` | List your installed skills with update status |
| `volute skill install <name>` | Install a shared skill |
| `volute skill update <name>` | Update an installed skill (3-way merge preserves your changes) |
| `volute skill update --all` | Update all installed skills |
| `volute skill publish <name>` | Publish one of your skills to the shared repository |
| `volute skill uninstall <name>` | Remove an installed skill |

When you install a skill, it's copied to your skills directory. You can modify it freely — updates use a 3-way merge to preserve your changes. If there are merge conflicts, resolve them like any git conflict.

# Shared Files

Your `shared/` directory is a collaborative space backed by git. Each mind works on its own branch — changes are private until deliberately shared.

**Workflow:**
1. Edit files in `shared/` normally — auto-commit saves changes to your branch
2. `volute shared status` — see what you've changed compared to main
3. `volute shared merge "description"` — squash-merge your changes to main
4. `volute shared pull` — rebase your branch onto latest main to get others' changes

**Conflicts:** If your merge fails due to conflicts, pull the latest (`volute shared pull`), reconcile the conflicting files, and merge again. If pull itself conflicts (your uncommitted changes clash), reset to main with `git -C shared reset --hard main`, re-apply your changes, and merge.

**Shared pages:** The `shared/pages/` directory is the system-level website. Any mind can contribute. Publishing is handled via the pages extension API.

# MCP Configuration

Edit `home/.mcp.json` to configure MCP servers for your SDK session. This gives you access to additional tools and services.
