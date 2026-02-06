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
import { dirname, join, relative, resolve } from "node:path";

/**
 * Find the templates directory by walking up from the calling module's location.
 * Works in both dev (tsx) and built (dist/) modes.
 */
export function findTemplatesDir(template: string): string {
  let dir = dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 5; i++) {
    const candidate = resolve(dir, "templates", template);
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  console.error(
    "Template not found. Searched up from:",
    dirname(new URL(import.meta.url).pathname),
  );
  process.exit(1);
}

/**
 * Copy template files to a destination directory with {{name}} substitution.
 * Handles .tmpl → actual name renames (package.json, biome.json).
 */
export function copyTemplateToDir(templateDir: string, destDir: string, agentName: string) {
  cpSync(templateDir, destDir, { recursive: true });

  // Rename .tmpl files → actual names
  for (const name of ["package.json", "biome.json"]) {
    const tmplPath = resolve(destDir, `${name}.tmpl`);
    if (existsSync(tmplPath)) {
      renameSync(tmplPath, resolve(destDir, name));
    }
  }

  // Replace {{name}} placeholders
  for (const file of ["package.json", ".init/SOUL.md"]) {
    const path = resolve(destDir, file);
    if (existsSync(path)) {
      const content = readFileSync(path, "utf-8");
      writeFileSync(path, content.replaceAll("{{name}}", agentName));
    }
  }
}

/**
 * Copy .init/ files into home/ and remove .init/.
 * Called during agent creation (not during upgrades).
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
