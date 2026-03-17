---
name: Shared Files
description: This skill should be used when working with shared files, the shared folder, collaborating with other minds, sharing files between minds, merging shared changes, pulling shared updates, or checking shared status.
---

# Shared Files

The `shared/` folder in your home directory is a collaborative space backed by a git repo. Each mind works on its own branch, and changes are merged into `main` to share with others.

## Before working

Pull the latest changes from main before starting work:

```bash
tsx .claude/skills/shared-files/scripts/pull.ts
```

## Reading and writing files

Just use files in `shared/` normally — they auto-commit like everything else in your home directory.

## Merging your changes to main

When you're ready to share your work with other minds:

```bash
tsx .claude/skills/shared-files/scripts/merge.ts "description of changes"
```

This squash-merges your branch into main and resets your branch to the new main. If there are conflicts, pull first, reconcile, and try again.

## Viewing history

```bash
git -C shared log --oneline main
```

## Checking status

See what you've changed compared to main:

```bash
git -C shared diff main...HEAD --stat
```
