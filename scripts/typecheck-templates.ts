/**
 * Typecheck composed templates by layering _base + overlay, installing deps, and running tsc.
 * Usage: npx tsx scripts/typecheck-templates.ts [template...]
 * If no templates are specified, all templates (claude, pi, codex) are checked.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  composeTemplate,
  findTemplatesRoot,
} from "../packages/daemon/src/lib/template/template.js";

const ALL_TEMPLATES = ["claude", "pi", "codex"];

let templatesRoot: string;
try {
  templatesRoot = findTemplatesRoot();
} catch {
  console.error("Could not find templates directory. Run from the repo root.");
  process.exit(1);
}

const requested = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const templates = requested.length > 0 ? requested : ALL_TEMPLATES;

let failed = false;

for (const name of templates) {
  console.log(`\n--- typechecking template: ${name} ---`);

  let composedDir: string;
  let manifest: { rename: Record<string, string>; substitute: string[] };
  try {
    ({ composedDir, manifest } = composeTemplate(templatesRoot, name));
  } catch (err: any) {
    console.error(`  ✗ ${name} failed to compose: ${err?.message ?? err}`);
    failed = true;
    continue;
  }

  // Apply renames (e.g. package.json.tmpl → package.json) in-place
  for (const [from, to] of Object.entries(manifest.rename)) {
    const fromPath = resolve(composedDir, from);
    if (existsSync(fromPath)) {
      renameSync(fromPath, resolve(composedDir, to));
    }
  }

  // Substitute {{name}} placeholders
  for (const file of manifest.substitute) {
    const path = resolve(composedDir, file);
    if (existsSync(path)) {
      const content = readFileSync(path, "utf-8");
      writeFileSync(path, content.replaceAll("{{name}}", "typecheck-test"));
    }
  }

  try {
    console.log(`  installing deps...`);
    execFileSync("npm", ["install", "--ignore-scripts"], {
      cwd: composedDir,
      stdio: ["ignore", "ignore", "pipe"],
    });

    console.log(`  running tsc...`);
    execFileSync("npx", ["tsc", "--noEmit"], {
      cwd: composedDir,
      stdio: "inherit",
    });

    console.log(`  ✓ ${name} passed`);
  } catch (err: any) {
    if (err?.stderr?.length) {
      console.error(err.stderr.toString());
    }
    console.error(`  ✗ ${name} failed`);
    failed = true;
  } finally {
    rmSync(composedDir, { recursive: true, force: true });
  }
}

if (failed) {
  process.exit(1);
}
