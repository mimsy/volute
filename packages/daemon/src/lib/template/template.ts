import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

export type TemplateManifest = {
  rename: Record<string, string>;
  substitute: string[];
};

/**
 * Find the templates root directory by walking up from the calling module's location.
 * Returns the parent `templates/` directory (not a specific template).
 */
let _templatesRoot: string | null = null;

/**
 * Locate the templates root, returning null instead of exiting when it isn't
 * found. Callers running inside the long-lived daemon must use this: the
 * `process.exit(1)` in {@link findTemplatesRoot} is appropriate for one-shot CLI
 * use but would take down every mind on the host, and no try/catch can stop it.
 */
export function locateTemplatesRoot(): string | null {
  if (_templatesRoot) return _templatesRoot;
  let dir = dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 7; i++) {
    const candidate = resolve(dir, "templates");
    if (existsSync(resolve(candidate, "_base"))) {
      _templatesRoot = candidate;
      return _templatesRoot;
    }
    dir = dirname(dir);
  }
  return null;
}

export function findTemplatesRoot(): string {
  const root = locateTemplatesRoot();
  if (root) return root;
  console.error(
    "Templates directory not found. Searched up from:",
    dirname(new URL(import.meta.url).pathname),
  );
  process.exit(1);
}

export function findTemplatesDir(template: string): string {
  const root = findTemplatesRoot();
  const dir = resolve(root, template);
  if (!existsSync(dir)) {
    console.error(`Template not found: ${template}`);
    process.exit(1);
  }
  return dir;
}

/**
 * Compose a template by layering _base + template-specific files into a temp directory.
 * Returns the composed dir path and parsed manifest.
 */
export function composeTemplate(
  templatesRoot: string,
  templateName: string,
): { composedDir: string; manifest: TemplateManifest } {
  const baseDir = resolve(templatesRoot, "_base");
  const templateDir = resolve(templatesRoot, templateName);

  if (!existsSync(baseDir)) {
    console.error("Base template not found:", baseDir);
    process.exit(1);
  }
  if (!existsSync(templateDir)) {
    console.error(`Template not found: ${templateName}`);
    process.exit(1);
  }

  // Create a unique temp staging directory. A timestamp suffix is not enough: two
  // concurrent compositions of the same template in the same millisecond would share
  // the dir, and one's cleanup rmSync yanks it out from under the other (test flake).
  const composedDir = mkdtempSync(resolve(tmpdir(), `volute-template-${templateName}-`));

  // Copy _base first
  cpSync(baseDir, composedDir, { recursive: true });

  // Overlay template-specific files (overwriting base files where they conflict)
  for (const file of listFiles(templateDir)) {
    const src = resolve(templateDir, file);
    const dest = resolve(composedDir, file);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest);
  }

  // Read manifest
  const manifestPath = resolve(composedDir, "volute-template.json");
  if (!existsSync(manifestPath)) {
    rmSync(composedDir, { recursive: true, force: true });
    console.error(`Template manifest not found: ${templateName}/volute-template.json`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as TemplateManifest;

  // Remove manifest from composed output
  rmSync(manifestPath);

  return { composedDir, manifest };
}

/**
 * Copy a composed template to the destination directory with name substitution.
 *
 * `manifest.substitute` is the single source of truth for which files carry
 * `{{name}}`, and its paths are relative to the *composed* layout — so a file
 * that ships via `.init/` must be listed under its `.init/...` path, not the
 * `home/...` path it eventually lands at. Substitution runs here, before
 * applyInitFiles() overlays `.init/` onto `home/`; listing the `home/` path for
 * a file that `.init/` shadows substitutes a copy that is then overwritten
 * (which is how `@{{name}}` shipped verbatim in every mind's routes.json).
 */
export function copyTemplateToDir(
  composedDir: string,
  destDir: string,
  mindName: string,
  manifest: TemplateManifest,
) {
  cpSync(composedDir, destDir, { recursive: true });

  // Rename files per manifest
  for (const [from, to] of Object.entries(manifest.rename)) {
    const fromPath = resolve(destDir, from);
    if (existsSync(fromPath)) {
      renameSync(fromPath, resolve(destDir, to));
    }
  }

  // Replace {{name}} placeholders in specified files
  for (const file of manifest.substitute) {
    const path = resolve(destDir, file);
    if (existsSync(path)) {
      const content = readFileSync(path, "utf-8");
      writeFileSync(path, content.replaceAll("{{name}}", mindName));
    }
  }
}

/**
 * Substitute {{name}} in the composed template's package.json.
 *
 * composeTemplate() leaves package.json under its real name but with the
 * {{name}} placeholder unsubstituted — the substitution normally happens in
 * copyTemplateToDir(). Callers that read composedDir/package.json directly (e.g.
 * syncSpiritTemplate) must render it first, otherwise a template switch silently
 * skips updating deps / npm install. Idempotent (replaceAll on an already-
 * substituted file is a no-op); returns the package.json path, or null if the
 * template ships no package.json.
 */
export function renderComposedPackageJson(composedDir: string, mindName: string): string | null {
  const dest = resolve(composedDir, "package.json");
  if (!existsSync(dest)) return null;
  const content = readFileSync(dest, "utf-8").replaceAll("{{name}}", mindName);
  writeFileSync(dest, content);
  return dest;
}

/**
 * Copy .init/ files into home/ and remove .init/.
 * Called during mind creation (not during upgrades).
 */
export function applyInitFiles(destDir: string) {
  const initDir = resolve(destDir, ".init");
  if (!existsSync(initDir)) return;

  const homeDir = resolve(destDir, "home");
  for (const file of listFiles(initDir)) {
    const src = resolve(initDir, file);
    const dest = resolve(homeDir, file);
    const parent = dirname(dest);
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }
    cpSync(src, dest);
  }

  rmSync(initDir, { recursive: true, force: true });
}

/**
 * The `.init/` subtrees that hold *infrastructure* rather than *identity*.
 *
 * Every file under `.init/` is copied into `home/` once, at mind creation, and
 * upgrades deliberately never touch `.init/` again — that exclusion is what
 * keeps a mind's SOUL.md and MEMORY.md safe from the template. But `.init/`
 * carries two different kinds of thing, and the exclusion was blocking both.
 *
 * The property that separates them is authorship: **could this mind have
 * written it about itself?** SOUL.md, MEMORY.md, `memory/`, and `.config/` are
 * the mind's own — what it is, what it remembers, how it is wired. Re-adding
 * those would be the framework talking over the mind.
 *
 * `home/.local/` is the opposite: it is Volute's machinery namespace inside the
 * home directory. The daemon generates skill shims into `.local/bin/` and
 * executes `.local/hooks/<event>/` itself. Those are safe to *add*, and are
 * added by {@link backfillInitInfrastructure} on upgrade.
 *
 * "Add, never overwrite" still holds inside `.local/`: a mind may have edited
 * its own hook (the shipped ones invite exactly that in their header comments),
 * and that edit is authorship too.
 *
 * One honest limit: absence is ambiguous. The backfill cannot tell "this mind
 * predates the hook" from "this mind deleted the hook on purpose", so a
 * deliberately removed hook comes back on the next upgrade. Deleting is a form
 * of authorship and this does override it. Distinguishing the two needs
 * per-mind tombstone state that does not exist today; until it does, a mind
 * that wants a hook gone should empty the file rather than remove it — a
 * present-but-empty hook is respected forever, and hook-loader treats it as a
 * no-op.
 *
 * This is a subtree rule, not a filename list, so a hook added under
 * `.local/hooks/` in future is covered the day it ships with no second edit
 * here. `test/template-init-classification.test.ts` pins the classification of
 * every `.init/` file the templates ship, so any newly shipped `.init/` file,
 * at any depth, fails the suite until someone classifies it on purpose.
 */
export const INIT_INFRASTRUCTURE_PREFIXES = [".local/"] as const;

/** Whether a `.init/`-relative path is framework infrastructure (see {@link INIT_INFRASTRUCTURE_PREFIXES}). */
export function isInitInfrastructure(relPath: string): boolean {
  const normalized = relPath.split(sep).join("/");
  return INIT_INFRASTRUCTURE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * Copy `.init/` infrastructure files that are *missing* from a mind's `home/`.
 *
 * The upgrade-side counterpart to {@link applyInitFiles}. Without it, any
 * capability shipped as a new hook or shim reaches only minds created after it
 * existed, while the daemon-side half of the feature ships and looks healthy —
 * which is how every mind on the production host but the newest ended up unable
 * to read its own next-turn system events (#808).
 *
 * Never overwrites: a file already present is the mind's, whether it authored
 * the content or merely kept it. Returns the `home/`-relative paths added.
 *
 * These paths live under `home/.local/`, which the template `.gitignore` does
 * not allowlist, so this writes untracked files and cannot interact with the
 * upgrade's git merge.
 *
 * Throws rather than exiting when the template can't be composed. Both callers
 * run inside the daemon, and `composeTemplate`/`findTemplatesRoot` `process.exit(1)`
 * on a missing templates root, template dir, or manifest — uncatchable, and fatal
 * to every mind on the host. The pre-checks below cover exactly those exit paths
 * so a broken install degrades to one warning.
 */
export function backfillInitInfrastructure(
  homeDir: string,
  template: string,
  mindName: string,
): string[] {
  const root = locateTemplatesRoot();
  if (!root) throw new Error("templates root not found on disk");
  if (!existsSync(resolve(root, template, "volute-template.json"))) {
    throw new Error(`template "${template}" is missing or has no manifest at ${root}`);
  }

  const { composedDir, manifest } = composeTemplate(root, template);
  try {
    const initDir = resolve(composedDir, ".init");
    if (!existsSync(initDir)) return [];

    // manifest.substitute paths are relative to the composed layout (".init/..."),
    // while listFiles() below yields paths relative to .init/ itself.
    const substitute = new Set(
      manifest.substitute
        .map((p) => p.split(sep).join("/"))
        .filter((p) => p.startsWith(".init/"))
        .map((p) => p.slice(".init/".length)),
    );
    const added: string[] = [];

    for (const file of listFiles(initDir)) {
      const rel = file.split(sep).join("/");
      if (!isInitInfrastructure(rel)) continue;

      const dest = resolve(homeDir, file);
      if (existsSync(dest)) continue;

      const src = resolve(initDir, file);
      mkdirSync(dirname(dest), { recursive: true });
      if (substitute.has(rel)) {
        writeFileSync(dest, readFileSync(src, "utf-8").replaceAll("{{name}}", mindName));
        // cpSync would have carried the source mode across; a substituted file is
        // written fresh, so restore it (the `volute` shim has to stay executable).
        chmodSync(dest, statSync(src).mode);
      } else {
        cpSync(src, dest);
      }
      added.push(rel);
    }

    return added;
  } finally {
    rmSync(composedDir, { recursive: true, force: true });
  }
}

/** Per-runtime mechanics doc filename by template. */
const MECHANICS_DOCS: Record<string, string> = {
  claude: "CLAUDE.md",
  pi: "MINDS.md",
  codex: "AGENTS.md",
};

/** Whether `template` is a known built-in template. */
export function isKnownTemplate(template: string): boolean {
  return template in MECHANICS_DOCS;
}

/**
 * Swap the template-owned files under home/ (mechanics doc, .claude/settings.json,
 * and .config/config.json) to match a different template. Used when a mind switches
 * templates (e.g. claude → pi) during upgrade: these files are written at creation
 * time and excluded from the template branch (updateTemplateBranch strips all of
 * home/ except VOLUTE.md), so the normal upgrade merge never updates them.
 * Leaves mind-authored files (SOUL.md, MEMORY.md, memory/, etc.) untouched.
 */
export function applyTemplateHomeFiles(homeDir: string, template: string) {
  const root = findTemplatesRoot();

  // Resolve (and verify) the new mechanics doc before deleting the old one, so a
  // failure can't leave the mind with no mechanics doc at all.
  const newDoc = MECHANICS_DOCS[template];
  const newDocSrc = newDoc ? resolve(root, template, ".init", newDoc) : undefined;
  if (!newDocSrc || !existsSync(newDocSrc)) {
    throw new Error(`No mechanics doc for template "${template}"`);
  }

  // Mechanics doc: remove any existing one, then write the target's.
  for (const doc of Object.values(MECHANICS_DOCS)) {
    rmSync(resolve(homeDir, doc), { force: true });
  }
  cpSync(newDocSrc, resolve(homeDir, newDoc));

  // .claude/settings.json is claude-only.
  const settingsDest = resolve(homeDir, ".claude", "settings.json");
  if (template === "claude") {
    mkdirSync(dirname(settingsDest), { recursive: true });
    cpSync(resolve(root, "claude", ".init", ".claude", "settings.json"), settingsDest);
  } else {
    rmSync(settingsDest, { force: true });
  }

  // config.json: regenerate from the target's config (template-specific overrides _base).
  const templateConfig = resolve(root, template, "home", ".config", "config.json");
  const configSrc = existsSync(templateConfig)
    ? templateConfig
    : resolve(root, "_base", "home", ".config", "config.json");
  const configDest = resolve(homeDir, ".config", "config.json");
  mkdirSync(dirname(configDest), { recursive: true });
  writeFileSync(configDest, readFileSync(configSrc, "utf-8"));
}

/**
 * List all files in a directory recursively (relative paths).
 */
export function listFiles(dir: string): string[] {
  const results: string[] = [];
  function walk(current: string) {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        // Skip .git directories
        if (entry === ".git") continue;
        walk(full);
      } else {
        results.push(relative(dir, full));
      }
    }
  }
  walk(dir);
  return results;
}
