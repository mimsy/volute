# Standard Skills System Design

## Summary

Move built-in skills out of the template system into a first-class shared skill pool. Skills are synced to the shared pool on daemon startup, auto-installed into new minds using the existing install/update flow, and updatable independently of template upgrades.

## Current State

- 4 skills in `templates/_base/_skills/`: `memory`, `sessions`, `orientation`, `volute-mind`
- Baked into minds at creation time via `composeTemplate()` → `_skills → skillsDir` mapping
- No upstream tracking after creation — updates require `volute mind upgrade`
- Separate shared skill system exists (DB + `~/.volute/skills/`, install/update/publish with 3-way merge)
- Seeds get `orientation` only; on sprout, `volute-mind`/`memory`/`sessions` are copied from template

## Design

### 1. Move skill source files

Move `templates/_base/_skills/` to `skills/` at repo root:

```
skills/
├── memory/SKILL.md
├── sessions/SKILL.md
├── orientation/SKILL.md
└── volute-mind/SKILL.md
```

### 2. Daemon startup sync

New `syncBuiltinSkills()` in `src/lib/skills.ts`:

- Finds `skills/` directory relative to module (via `findSkillsRoot()`, similar to `findTemplatesRoot()`)
- For each skill, compares content hash against shared pool
- If changed/new: calls `importSkillFromDir()` with `author="volute"` (bumps version)
- If unchanged: skips (no version bump)
- Called from daemon startup after DB init

Hash comparison prevents version inflation on restarts.

### 3. Default skill sets

```typescript
export const SEED_SKILLS = ["orientation", "memory"];
export const STANDARD_SKILLS = ["volute-mind", "memory", "sessions"];
```

### 4. Mind creation

- After `applyInitFiles()` + git init, install skills from shared pool via `installSkill()`
- Seeds: install `SEED_SKILLS`; non-seeds: install `STANDARD_SKILLS`
- Accept optional `skills` array in create request body (overrides default)
- CLI: `--skills` flag on `volute seed`/`volute mind create` (comma-separated, or `"none"`)
- UI: skill picker on create mind form, pre-selects standard set

### 5. Sprout changes

- Install missing `STANDARD_SKILLS` from shared pool (not from template)
- Uninstall `orientation`
- Remove `composeTemplate()` call from sprout

### 6. Template cleanup

- Remove `_skills/` from `templates/_base/`
- Remove `skillsDir` from `TemplateManifest` and `volute-template.json` files
- Remove `_skills → skillsDir` mapping code from `composeTemplate()`

### 7. Build

- `tsup` config: ensure `skills/` is included in build output
- New `findSkillsRoot()` function to locate skills at runtime

## Migration

Existing minds are unaffected — their skills stay as-is with no upstream tracking. They can `volute skill install` to get the shared versions if they want upstream tracking.
