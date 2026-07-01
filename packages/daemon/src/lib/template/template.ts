import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

export type TemplateManifest = {
  rename: Record<string, string>;
  substitute: string[];
};

/**
 * Find the templates root directory by walking up from the calling module's location.
 * Returns the parent `templates/` directory (not a specific template).
 */
let _templatesRoot: string | null = null;
export function findTemplatesRoot(): string {
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

  // Create temp staging directory (include template name to avoid collisions when
  // composing multiple templates in quick succession, e.g. in tests)
  const composedDir = resolve(tmpdir(), `volute-template-${templateName}-${Date.now()}`);
  mkdirSync(composedDir, { recursive: true });

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

  // config.json: regenerate from the target's tmpl (template-specific overrides _base).
  const templateConfig = resolve(root, template, "home", ".config", "config.json.tmpl");
  const configTmpl = existsSync(templateConfig)
    ? templateConfig
    : resolve(root, "_base", "home", ".config", "config.json.tmpl");
  const configDest = resolve(homeDir, ".config", "config.json");
  mkdirSync(dirname(configDest), { recursive: true });
  writeFileSync(configDest, readFileSync(configTmpl, "utf-8"));
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
