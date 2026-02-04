import {
  cpSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  readdirSync,
  statSync,
} from "fs";
import { resolve, dirname, relative, join } from "path";

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
 * Handles package.json.tmpl → package.json rename.
 */
export function copyTemplateToDir(
  templateDir: string,
  destDir: string,
  agentName: string,
) {
  cpSync(templateDir, destDir, { recursive: true });

  // Rename package.json.tmpl → package.json
  const tmplPath = resolve(destDir, "package.json.tmpl");
  if (existsSync(tmplPath)) {
    renameSync(tmplPath, resolve(destDir, "package.json"));
  }

  // Replace {{name}} placeholders
  for (const file of ["package.json", "home/SOUL.md"]) {
    const path = resolve(destDir, file);
    if (existsSync(path)) {
      const content = readFileSync(path, "utf-8");
      writeFileSync(path, content.replaceAll("{{name}}", agentName));
    }
  }
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
