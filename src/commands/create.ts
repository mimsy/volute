import { cpSync, readFileSync, writeFileSync, renameSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { execSync } from "child_process";

export async function run(args: string[]) {
  const name = args[0];
  if (!name) {
    console.error("Usage: molt create <name>");
    process.exit(1);
  }

  const dest = resolve(process.cwd(), name);
  if (existsSync(dest)) {
    console.error(`Directory already exists: ${dest}`);
    process.exit(1);
  }

  // Find the templates directory relative to this CLI file
  // cli.ts is at src/commands/create.ts, templates are at ../../templates/
  const cliDir = dirname(dirname(dirname(new URL(import.meta.url).pathname)));
  const templateDir = resolve(cliDir, "templates", "anthropic");

  if (!existsSync(templateDir)) {
    console.error(`Template not found: ${templateDir}`);
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

  // git init + initial commit
  execSync("git init", { cwd: dest, stdio: "pipe" });
  execSync("git add -A", { cwd: dest, stdio: "pipe" });
  execSync('git commit -m "initial commit"', { cwd: dest, stdio: "pipe" });

  // Install dependencies
  console.log("Installing dependencies...");
  execSync("bun install", { cwd: dest, stdio: "inherit" });

  console.log(`\nCreated agent: ${name}`);
  console.log(`\n  cd ${name}`);
  console.log(`  molt start`);
}
