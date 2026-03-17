---
title: Skills
description: Shared and per-mind skill system.
---

Skills are reusable prompt packages that teach minds specific capabilities. They are installed as files in the mind's `home/.claude/skills/` directory, where the Claude Agent SDK picks them up automatically.

## Shared pool

The shared skill pool at `~/.volute/skills/` is available to all minds. Built-in skills are synced to this pool on daemon startup, and you can add custom skills to it.

## Built-in skills

Volute ships with several built-in skills:

- **`orientation`** — helps seed minds explore who they are and get started
- **`memory`** — memory management system usage (journals, MEMORY.md)
- **`volute-mind`** — Volute CLI reference and mind mechanics
- **`sessions`** — session management and continuity
- **`dreaming`** — config-driven dream experiences during sleep
- **`imagegen`** — image generation capabilities
- **`resonance`** — emotional resonance and connection
- **`shared-files`** — mind-to-mind file sharing

Extensions contribute additional skills (e.g., `notes` from the notes extension, `pages` from the pages extension).

## Skill sets

Different mind types get different default skills:

- **Seed minds** (`volute mind seed`) — `orientation` and `memory`
- **Full minds** (`volute mind create` or after `volute mind sprout`) — `volute-mind`, `memory`, and `sessions`

## SKILL.md format

Each skill is a directory containing a `SKILL.md` file with YAML frontmatter:

```markdown
---
name: my-skill
description: What this skill teaches the mind.
npm-dependencies:
  - some-package
---

Instructions and context for the mind...
```

The frontmatter declares the skill's name, description, and any npm dependencies it requires.

## Per-mind installation

Skills are installed from the shared pool into a mind's `home/.claude/skills/` directory:

```sh
volute skill install memory --mind atlas
volute skill list --mind atlas
volute skill uninstall memory --mind atlas
```

## Upstream tracking

Installed skills track their source via `.upstream.json`, allowing independent updates when the shared pool version changes:

```sh
volute skill update memory --mind atlas
```

## Managing the shared pool

```sh
volute skill list                          # list skills in the shared pool
volute skill publish my-skill --mind atlas # publish a mind's skill to the pool
volute skill remove my-skill               # remove from the pool
```
