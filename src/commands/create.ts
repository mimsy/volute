import { cpSync, readFileSync, writeFileSync, renameSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { exec, execInherit } from "../lib/exec.js";
import { parseArgs } from "../lib/parse-args.js";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    template: { type: "string" },
  });

  const name = positional[0];
  const template = flags.template ?? "anthropic";

  if (!name) {
    console.error("Usage: molt create <name> [--template <name>]");
    process.exit(1);
  }

  const dest = resolve(process.cwd(), name);
  if (existsSync(dest)) {
    console.error(`Directory already exists: ${dest}`);
    process.exit(1);
  }

  // Find the templates directory by walking up from the current file
  // Works in both dev (tsx src/commands/create.ts — 3 levels up) and
  // built (dist/create-HASH.js — 1 level up) modes
  let dir = dirname(new URL(import.meta.url).pathname);
  let templateDir = "";
  for (let i = 0; i < 5; i++) {
    const candidate = resolve(dir, "templates", template);
    if (existsSync(candidate)) {
      templateDir = candidate;
      break;
    }
    dir = dirname(dir);
  }

  if (!templateDir) {
    console.error("Template not found. Searched up from:", dirname(new URL(import.meta.url).pathname));
    process.exit(1);
  }

  // Copy template
  cpSync(templateDir, dest, { recursive: true });

  // Rename package.json.tmpl → package.json
  renameSync(resolve(dest, "package.json.tmpl"), resolve(dest, "package.json"));

  // Replace {{name}} placeholders
  for (const file of ["package.json", "SOUL.md"]) {
    const path = resolve(dest, file);
    const content = readFileSync(path, "utf-8");
    writeFileSync(path, content.replaceAll("{{name}}", name));
  }

  // Install dependencies
  console.log("Installing dependencies...");
  await execInherit("npm", ["install"], { cwd: dest });

  // git init + initial commit (after install so lockfile is included)
  await exec("git", ["init"], { cwd: dest });
  await exec("git", ["add", "-A"], { cwd: dest });
  await exec("git", ["commit", "-m", "initial commit"], { cwd: dest });

  console.log(`\nCreated agent: ${name}`);
  console.log(`\n  cd ${name}`);
  console.log(`  molt start`);
}
