# Standard Skills Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move built-in skills from templates into a shared skill pool, auto-synced on daemon startup, auto-installed on mind creation.

**Architecture:** Skills live in `skills/` at repo root. Daemon syncs them to the shared pool (`~/.volute/skills/`) with `author="volute"` on startup. Mind creation installs from the shared pool via existing `installSkill()`, giving every mind upstream tracking from day one.

**Tech Stack:** TypeScript, Node.js, libSQL (drizzle-orm), Hono, Svelte 5

---

### Task 1: Move skill files from template to repo root

**Files:**
- Create: `skills/memory/SKILL.md` (move from `templates/_base/_skills/memory/SKILL.md`)
- Create: `skills/sessions/SKILL.md` (move from `templates/_base/_skills/sessions/SKILL.md`)
- Create: `skills/orientation/SKILL.md` (move from `templates/_base/_skills/orientation/SKILL.md`)
- Create: `skills/volute-mind/SKILL.md` (move from `templates/_base/_skills/volute-mind/SKILL.md`)
- Delete: `templates/_base/_skills/` (entire directory)

**Step 1: Move the files**

```bash
mkdir -p skills
cp -r templates/_base/_skills/* skills/
rm -rf templates/_base/_skills
```

**Step 2: Verify files exist in new location**

```bash
ls skills/*/SKILL.md
```

Expected: 4 SKILL.md files listed.

**Step 3: Commit**

```bash
git add skills/ templates/_base/
git commit -m "refactor: move built-in skills from templates to skills/"
```

---

### Task 2: Remove skillsDir from template system

**Files:**
- Modify: `src/lib/template.ts:15-18` (remove `skillsDir` from `TemplateManifest`)
- Modify: `src/lib/template.ts:93-100` (remove `_skills → skillsDir` mapping)
- Modify: `templates/claude/volute-template.json` (remove `skillsDir`)
- Modify: `templates/pi/volute-template.json` (remove `skillsDir`)

**Step 1: Remove `skillsDir` from `TemplateManifest` type**

In `src/lib/template.ts`, remove the `skillsDir` field from the type:

```typescript
export type TemplateManifest = {
  rename: Record<string, string>;
  substitute: string[];
};
```

**Step 2: Remove `_skills → skillsDir` mapping code**

In `src/lib/template.ts` `composeTemplate()`, remove lines 93-100 (the `_skills` mapping block):

```typescript
  // Map _skills/ → skillsDir          ← DELETE
  const skillsSrc = ...                 ← DELETE
  if (existsSync(skillsSrc)) {          ← DELETE
    ...                                 ← DELETE
  }                                     ← DELETE
```

**Step 3: Remove `skillsDir` from manifest JSON files**

In `templates/claude/volute-template.json`, remove:
```json
  "skillsDir": "home/.claude/skills"
```

Do the same for `templates/pi/volute-template.json`.

**Step 4: Fix references to `manifest.skillsDir`**

Search for `manifest.skillsDir` or `skillsDir` usage outside `template.ts`. The `minds.ts` create endpoint (line ~385) and `sprout.ts` (line ~53) reference it — these will be updated in later tasks but need to not crash in the interim. For now, replace those references with the hardcoded path `"home/.claude/skills"` as a temporary measure (they'll be rewritten in Tasks 5 and 6).

In `src/web/api/minds.ts` (~line 385):
```typescript
const skillsDir = resolve(dest, "home/.claude/skills");
```

In `src/commands/sprout.ts` (~line 53-54):
```typescript
const skillsDir = resolve(dir, "home/.claude/skills");
const composedSkillsDir = resolve(composedDir, "home/.claude/skills");
```

**Step 5: Run tests**

```bash
npm test
```

Expected: All tests pass.

**Step 6: Commit**

```bash
git add src/lib/template.ts templates/claude/volute-template.json templates/pi/volute-template.json src/web/api/minds.ts src/commands/sprout.ts
git commit -m "refactor: remove skillsDir from template manifest"
```

---

### Task 3: Add `findSkillsRoot()` and `syncBuiltinSkills()`

**Files:**
- Modify: `src/lib/skills.ts` (add `findSkillsRoot()`, `syncBuiltinSkills()`, skill set constants)
- Test: `test/skills.test.ts`

**Step 1: Write failing test for `syncBuiltinSkills`**

Add to `test/skills.test.ts`:

```typescript
import {
  // ... existing imports ...
  syncBuiltinSkills,
  STANDARD_SKILLS,
  SEED_SKILLS,
} from "../src/lib/skills.js";

describe("syncBuiltinSkills", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("syncs built-in skills to shared pool with author=volute", async () => {
    await syncBuiltinSkills();
    const skills = await listSharedSkills();
    // Should have at least the standard skills
    const ids = skills.map(s => s.id).sort();
    assert.ok(ids.includes("memory"));
    assert.ok(ids.includes("sessions"));
    assert.ok(ids.includes("volute-mind"));
    assert.ok(ids.includes("orientation"));
    // All should have author "volute"
    for (const s of skills) {
      assert.equal(s.author, "volute");
    }
  });

  it("does not bump version on repeated sync with same content", async () => {
    await syncBuiltinSkills();
    const first = await getSharedSkill("memory");
    assert.ok(first);
    const v1 = first.version;

    await syncBuiltinSkills();
    const second = await getSharedSkill("memory");
    assert.ok(second);
    assert.equal(second.version, v1, "version should not bump on no-change re-sync");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- --test-name-pattern "syncBuiltinSkills"
```

Expected: FAIL — `syncBuiltinSkills` not exported.

**Step 3: Implement `findSkillsRoot()`, skill set constants, and `syncBuiltinSkills()`**

Add to `src/lib/skills.ts`:

```typescript
import { createHash } from "node:crypto";
import { dirname } from "node:path"; // add to existing imports

// Skill set constants
export const SEED_SKILLS = ["orientation", "memory"];
export const STANDARD_SKILLS = ["volute-mind", "memory", "sessions"];

// Find the skills/ directory at the repo/package root
export function findSkillsRoot(): string {
  let dir = dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 5; i++) {
    const candidate = resolve(dir, "skills");
    if (existsSync(resolve(candidate, "memory"))) return candidate;
    dir = dirname(dir);
  }
  throw new Error("Skills directory not found");
}

// Hash all files in a skill directory for change detection
function hashSkillDir(dir: string): string {
  const hash = createHash("sha256");
  const files = listFilesRecursive(dir).filter(f => f !== ".upstream.json").sort();
  for (const file of files) {
    hash.update(file);
    hash.update(readFileSync(join(dir, file)));
  }
  return hash.digest("hex");
}

// Sync built-in skills from skills/ to the shared pool
export async function syncBuiltinSkills(): Promise<void> {
  const skillsRoot = findSkillsRoot();
  const entries = readdirSync(skillsRoot, { withFileTypes: true }).filter(e => e.isDirectory());

  for (const entry of entries) {
    const sourceDir = join(skillsRoot, entry.name);
    if (!existsSync(join(sourceDir, "SKILL.md"))) continue;

    const sourceHash = hashSkillDir(sourceDir);
    const destDir = join(sharedSkillsDir(), entry.name);

    // Check if shared copy exists and has same content
    if (existsSync(destDir)) {
      const destHash = hashSkillDir(destDir);
      if (sourceHash === destHash) continue; // no changes
    }

    await importSkillFromDir(sourceDir, "volute");
  }
}
```

**Step 4: Run tests to verify they pass**

```bash
npm test -- --test-name-pattern "syncBuiltinSkills"
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/skills.ts test/skills.test.ts
git commit -m "feat: add syncBuiltinSkills for daemon startup skill sync"
```

---

### Task 4: Call `syncBuiltinSkills()` on daemon startup

**Files:**
- Modify: `src/daemon.ts` (~line 17, ~line 63)

**Step 1: Add import and call**

In `src/daemon.ts`, add import:
```typescript
import { syncBuiltinSkills } from "./lib/skills.js";
```

Call after `initRegistryCache()` (line ~64), before starting minds:
```typescript
  // Sync built-in skills to shared pool
  try {
    await syncBuiltinSkills();
  } catch (err) {
    log.warn("failed to sync built-in skills", log.errorData(err));
  }
```

**Step 2: Run tests**

```bash
npm test
```

Expected: All pass (daemon startup isn't tested directly, but skills tests cover the logic).

**Step 3: Commit**

```bash
git add src/daemon.ts
git commit -m "feat: sync built-in skills to shared pool on daemon startup"
```

---

### Task 5: Install skills from shared pool during mind creation

**Files:**
- Modify: `src/web/api/minds.ts` (create endpoint, ~line 293-429)
- Modify: `src/commands/create.ts`
- Modify: `src/commands/seed.ts`

**Step 1: Update create mind endpoint to install skills from shared pool**

In the create mind endpoint in `src/web/api/minds.ts`:

Add `skills` to the zod schema:
```typescript
const createMindSchema = z.object({
  name: z.string(),
  template: z.string().optional(),
  stage: z.enum(["seed", "sprouted"]).optional(),
  description: z.string().optional(),
  model: z.string().optional(),
  seedSoul: z.string().optional(),
  skills: z.array(z.string()).optional(),
});
```

Add import:
```typescript
import { installSkill, SEED_SKILLS, STANDARD_SKILLS, syncBuiltinSkills } from "../../lib/skills.js";
```

After the git init section (after `initTemplateBranch()`), replace the seed skill-removal block (lines ~384-389) with shared pool skill installation:

```typescript
      // Install skills from shared pool
      const skillIds = body.skills ?? (body.stage === "seed" ? SEED_SKILLS : STANDARD_SKILLS);
      for (const skillId of skillIds) {
        try {
          await installSkill(name, dest, skillId);
        } catch (err) {
          log.warn(`failed to install skill ${skillId} for ${name}`, log.errorData(err));
        }
      }
```

Remove the old seed skill-removal block:
```typescript
      if (body.stage === "seed") {
        // Remove full skills, keep only orientation
        const skillsDir = resolve(dest, manifest.skillsDir);
        for (const skill of ["volute-mind", "memory", "sessions"]) {
          ...
        }
      }
```

**Step 2: Add `--skills` flag to CLI commands**

In `src/commands/create.ts`, add `skills` flag:
```typescript
const { positional, flags } = parseArgs(args, {
  template: { type: "string" },
  skills: { type: "string" },
});
```

Pass through:
```typescript
body: JSON.stringify({
  name,
  template,
  skills: flags.skills === "none" ? [] : flags.skills?.split(","),
}),
```

In `src/commands/seed.ts`, add `skills` flag similarly.

**Step 3: Run tests**

```bash
npm test
```

Expected: All pass.

**Step 4: Commit**

```bash
git add src/web/api/minds.ts src/commands/create.ts src/commands/seed.ts
git commit -m "feat: install skills from shared pool during mind creation"
```

---

### Task 6: Update sprout to use shared pool

**Files:**
- Modify: `src/commands/sprout.ts`

**Step 1: Rewrite sprout skill installation**

Replace the template-based skill copying with shared pool operations:

```typescript
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { findMind, mindDir } from "../lib/registry.js";
import { installSkill, STANDARD_SKILLS, uninstallSkill, mindSkillsDir } from "../lib/skills.js";

const ORIENTATION_MARKER = "You don't have a soul yet";

export async function run(_args: string[]) {
  const mindName = process.env.VOLUTE_MIND;
  if (!mindName) {
    console.error("volute sprout must be run by a mind (VOLUTE_MIND not set)");
    process.exit(1);
  }

  const entry = findMind(mindName);
  if (!entry) {
    console.error(`Unknown mind: ${mindName}`);
    process.exit(1);
  }

  if (entry.stage !== "seed") {
    console.error(`${mindName} is not a seed — already at stage "${entry.stage}"`);
    process.exit(1);
  }

  const dir = mindDir(mindName);
  const soulPath = resolve(dir, "home/SOUL.md");
  const memoryPath = resolve(dir, "home/MEMORY.md");

  // Validate SOUL.md
  if (!existsSync(soulPath)) {
    console.error("Write your SOUL.md before sprouting.");
    process.exit(1);
  }
  const soul = readFileSync(soulPath, "utf-8");
  if (soul.includes(ORIENTATION_MARKER)) {
    console.error(
      "Your SOUL.md still contains the orientation template. Write your own identity first.",
    );
    process.exit(1);
  }

  // Validate MEMORY.md
  if (!existsSync(memoryPath)) {
    console.error("Write your MEMORY.md before sprouting.");
    process.exit(1);
  }

  // Install standard skills from shared pool (skip already installed)
  const skillsDir = mindSkillsDir(dir);
  for (const skillId of STANDARD_SKILLS) {
    const skillPath = resolve(skillsDir, skillId);
    if (!existsSync(skillPath)) {
      try {
        await installSkill(mindName, dir, skillId);
      } catch (err) {
        console.error(`Warning: failed to install skill ${skillId}: ${(err as Error).message}`);
      }
    }
  }

  // Remove orientation skill
  const orientationPath = resolve(skillsDir, "orientation");
  if (existsSync(orientationPath)) {
    try {
      await uninstallSkill(mindName, dir, "orientation");
    } catch {
      // If uninstall fails (no git tracking), just remove the directory
      rmSync(orientationPath, { recursive: true, force: true });
    }
  }

  // Flip stage via daemon API
  const { daemonFetch } = await import("../lib/daemon-client.js");
  const { getClient, urlOf } = await import("../lib/api-client.js");
  const client = getClient();

  const sproutRes = await daemonFetch(
    urlOf(client.api.minds[":name"].sprout.$url({ param: { name: mindName } })),
    { method: "POST" },
  );
  if (!sproutRes.ok) {
    const data = (await sproutRes.json()) as { error?: string };
    console.error(data.error ?? "Failed to update stage");
    process.exit(1);
  }

  // Restart with sprouted context
  const res = await daemonFetch(
    urlOf(client.api.minds[":name"].restart.$url({ param: { name: mindName } })),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context: { type: "sprouted" } }),
    },
  );

  if (!res.ok) {
    const data = (await res.json()) as { error?: string };
    console.error(data.error ?? "Failed to restart after sprouting");
    process.exit(1);
  }

  console.log("Sprouted! You now have full mind capabilities.");
}
```

**Step 2: Run tests**

```bash
npm test
```

Expected: All pass.

**Step 3: Commit**

```bash
git add src/commands/sprout.ts
git commit -m "refactor: sprout uses shared skill pool instead of templates"
```

---

### Task 7: Add skills to build output

**Files:**
- Modify: `tsup.config.ts`
- Modify: `package.json` (if needed for `files` field)

**Step 1: Ensure skills/ directory is copied to dist/**

`tsup` only compiles TypeScript — static assets need separate handling. Add a `postbuild` script or use the `onSuccess` hook in tsup to copy skills:

In `package.json`, check for existing build scripts and add:
```json
"scripts": {
  "build": "tsup && vite build -c src/web/ui/vite.config.ts && cp -r skills dist/skills"
}
```

Or if there's already a more complex build pipeline, add the copy step there.

Also ensure `skills/` is included in the npm `files` field if one exists in `package.json`.

**Step 2: Verify build works**

```bash
npm run build
ls dist/skills/*/SKILL.md
```

Expected: 4 SKILL.md files in dist/skills/.

**Step 3: Commit**

```bash
git add tsup.config.ts package.json
git commit -m "build: include skills/ directory in build output"
```

---

### Task 8: Add skill picker to SeedModal UI

**Files:**
- Modify: `src/web/ui/src/components/SeedModal.svelte`
- Modify: `src/web/ui/src/lib/api.ts` (add `fetchSharedSkills` if not already present, update `createSeedMind`)

**Step 1: Update `createSeedMind` API to accept skills**

In `src/web/ui/src/lib/api.ts`, update the function signature:
```typescript
export async function createSeedMind(
  name: string,
  opts?: { description?: string; template?: string; model?: string; seedSoul?: string; skills?: string[] },
): Promise<{ name: string; port: number }> {
  const res = await client.api.minds.$post({
    json: {
      name,
      stage: "seed" as const,
      description: opts?.description,
      template: opts?.template,
      model: opts?.model,
      seedSoul: opts?.seedSoul,
      skills: opts?.skills,
    },
  });
  ...
}
```

**Step 2: Add skill picker to SeedModal**

In `src/web/ui/src/components/SeedModal.svelte`, within the Advanced section:

- Fetch shared skills on mount (use existing `fetchSharedSkills`)
- Show checkboxes for each skill, pre-select `SEED_SKILLS` default set (orientation + memory)
- Pass selected skills to `createSeedMind()`

Add state:
```typescript
import { fetchSharedSkills, type SharedSkill } from "../lib/api";

let sharedSkills = $state<SharedSkill[]>([]);
let selectedSkills = $state<Set<string>>(new Set(["orientation", "memory"]));

onMount(() => {
  // ...existing prompt fetch...
  fetchSharedSkills()
    .then(s => { sharedSkills = s; })
    .catch(() => {});
});
```

Add UI in the Advanced section:
```svelte
{#if sharedSkills.length > 0}
  <div class="field">
    <span class="label">Skills</span>
    <div class="skill-checkboxes">
      {#each sharedSkills as skill}
        <label class="skill-checkbox">
          <input
            type="checkbox"
            checked={selectedSkills.has(skill.id)}
            onchange={() => {
              const next = new Set(selectedSkills);
              if (next.has(skill.id)) next.delete(skill.id);
              else next.add(skill.id);
              selectedSkills = next;
            }}
          />
          <span>{skill.name}</span>
        </label>
      {/each}
    </div>
  </div>
{/if}
```

Update submit:
```typescript
const skillsOverride = showAdvanced ? [...selectedSkills] : undefined;
await createSeedMind(trimmed, {
  ...existing opts...,
  skills: skillsOverride,
});
```

**Step 3: Run build and verify**

```bash
npm run dev:web
```

Verify the SeedModal shows skill checkboxes in the Advanced section.

**Step 4: Commit**

```bash
git add src/web/ui/src/components/SeedModal.svelte src/web/ui/src/lib/api.ts
git commit -m "feat: add skill picker to seed creation UI"
```

---

### Task 9: Update documentation

**Files:**
- Modify: `CLAUDE.md` (update architecture section re: skills)
- Modify: `templates/_base/_skills/volute-mind/SKILL.md` → now `skills/volute-mind/SKILL.md` (already moved)

**Step 1: Update CLAUDE.md**

In the Architecture section, update references:
- Change `templates/_base/_skills/` references to `skills/`
- Note that skills are synced to shared pool on daemon startup
- Mention `SEED_SKILLS` and `STANDARD_SKILLS` constants

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update architecture docs for standard skills system"
```

---

### Task 10: Final integration test

**Step 1: Run full test suite**

```bash
npm test
```

Expected: All tests pass.

**Step 2: Run build**

```bash
npm run build
```

Expected: Clean build, skills/ in dist/.

**Step 3: Manual smoke test (optional)**

- Start daemon, verify `volute skill list` shows built-in skills with `author=volute`
- Create a seed mind, verify it gets orientation + memory skills with upstream tracking
- Sprout the seed, verify it gets volute-mind + sessions and orientation is removed

**Step 4: Final commit if any fixups needed**
