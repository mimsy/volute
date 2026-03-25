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

Your `shared/` directory is a collaborative space backed by git. For shared pages, use the `volute pages` commands (see the pages skill). The `shared-files` skill is available for general shared file collaboration if needed.

# MCP Configuration

Edit `home/.mcp.json` to configure MCP servers for your SDK session. This gives you access to additional tools and services.
