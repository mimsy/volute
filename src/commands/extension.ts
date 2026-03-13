import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { daemonFetch } from "../lib/daemon-client.js";
import { exec } from "../lib/exec.js";

/** User-writable directory for npm-installed extensions. */
function extensionsNpmDir(): string {
  const home = process.env.VOLUTE_HOME ?? resolve(process.env.HOME ?? "", ".volute");
  return resolve(home, "extensions", "_npm");
}

/** Ensure the extensions npm directory has a package.json. */
function ensureExtensionsNpmDir(): string {
  const dir = extensionsNpmDir();
  mkdirSync(dir, { recursive: true });
  const pkgPath = resolve(dir, "package.json");
  if (!existsSync(pkgPath)) {
    writeFileSync(pkgPath, '{"private":true,"dependencies":{}}\n');
  }
  return dir;
}

export async function run(args: string[]) {
  const subcommand = args[0];

  switch (subcommand) {
    case "list":
      await listExtensions();
      break;
    case "install":
      await installExtension(args.slice(1));
      break;
    case "uninstall":
      await uninstallExtension(args.slice(1));
      break;
    case "--help":
    case "-h":
    case undefined:
      printUsage();
      break;
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      printUsage();
      process.exit(1);
  }
}

function printUsage() {
  console.log(`Usage:
  volute extension list                List installed extensions
  volute extension install <package>   Install a third-party extension
  volute extension uninstall <package> Uninstall a third-party extension`);
}

async function listExtensions() {
  const res = await daemonFetch("/api/extensions");
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: "Unknown error" }))) as {
      error: string;
    };
    console.error(`Error: ${body.error}`);
    process.exit(1);
  }

  const extensions = (await res.json()) as Array<{
    id: string;
    name: string;
    version: string;
    description?: string;
  }>;

  if (extensions.length === 0) {
    console.log("No extensions installed.");
    return;
  }

  console.log("Extensions:\n");
  for (const ext of extensions) {
    console.log(`  ${ext.id} — ${ext.name} v${ext.version}`);
    if (ext.description) console.log(`    ${ext.description}`);
  }
}

function extensionsConfigPath(): string {
  const home = process.env.VOLUTE_HOME ?? resolve(process.env.HOME ?? "", ".volute");
  return resolve(home, "system", "extensions.json");
}

function readConfig(): string[] {
  const configPath = extensionsConfigPath();
  if (!existsSync(configPath)) return [];
  try {
    const data = JSON.parse(readFileSync(configPath, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error(
      `Warning: failed to read extensions config at ${configPath}: ${(err as Error).message}`,
    );
    return [];
  }
}

function writeConfig(packages: string[]): void {
  const configPath = extensionsConfigPath();
  mkdirSync(resolve(configPath, ".."), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(packages, null, 2)}\n`);
}

async function installExtension(args: string[]) {
  const pkg = args[0];
  if (!pkg) {
    console.error("Usage: volute extension install <package>");
    process.exit(1);
  }

  const packages = readConfig();
  if (packages.includes(pkg)) {
    console.log(`Extension "${pkg}" is already installed.`);
    return;
  }

  const dir = ensureExtensionsNpmDir();
  console.log(`Installing "${pkg}"...`);
  try {
    await exec("npm", ["install", pkg], { cwd: dir });
  } catch (err) {
    console.error(`Failed to install "${pkg}": ${(err as Error).message}`);
    process.exit(1);
  }

  packages.push(pkg);
  writeConfig(packages);
  console.log(`Installed "${pkg}".`);
  console.log("Restart the daemon (`volute restart`) to load the extension.");
}

async function uninstallExtension(args: string[]) {
  const pkg = args[0];
  if (!pkg) {
    console.error("Usage: volute extension uninstall <package>");
    process.exit(1);
  }

  const packages = readConfig();
  const idx = packages.indexOf(pkg);
  if (idx === -1) {
    console.error(`Extension "${pkg}" is not installed.`);
    process.exit(1);
  }

  // Try to clean up contributed skills before removing the package
  await cleanupExtensionSkills(pkg);

  packages.splice(idx, 1);
  writeConfig(packages);

  try {
    await exec("npm", ["uninstall", pkg], { cwd: extensionsNpmDir() });
  } catch (err) {
    console.warn(
      `  Warning: npm uninstall failed (package may have been manually removed): ${(err as Error).message}`,
    );
  }

  console.log(`Removed "${pkg}".`);
  console.log("Restart the daemon (`volute restart`) to unload the extension.");
}

/**
 * Try to discover and remove skills contributed by an extension before uninstall.
 * Looks for a skillsDir in the package and removes matching skills from defaults and the shared pool.
 */
async function cleanupExtensionSkills(pkg: string): Promise<void> {
  try {
    const pkgDir = resolve(extensionsNpmDir(), "node_modules", pkg);
    if (!existsSync(pkgDir)) return;

    // Try to find a skills directory by loading the manifest
    const { createRequire } = await import("node:module");
    const require = createRequire(resolve(extensionsNpmDir(), "noop.js"));
    const mod = require(pkg);
    const manifest = mod.default ?? mod.extension ?? mod;
    if (!manifest?.skillsDir || !existsSync(manifest.skillsDir)) return;

    const skillDirs = readdirSync(manifest.skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const skillId of skillDirs) {
      // Remove from defaults (ignore errors — skill may not be a default)
      await daemonFetch(`/api/skills/defaults/list/${encodeURIComponent(skillId)}`, {
        method: "DELETE",
      }).catch(() => {});
      // Remove from shared pool
      await daemonFetch(`/api/skills/${encodeURIComponent(skillId)}`, {
        method: "DELETE",
      }).catch(() => {});
      console.log(`  Removed skill: ${skillId}`);
    }
  } catch (err) {
    console.warn(`  Warning: could not clean up skills for "${pkg}": ${(err as Error).message}`);
  }
}
