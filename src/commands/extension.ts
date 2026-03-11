import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { daemonFetch } from "../lib/daemon-client.js";

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
  } catch {
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

  packages.push(pkg);
  writeConfig(packages);
  console.log(`Added "${pkg}" to extensions config.`);
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

  packages.splice(idx, 1);
  writeConfig(packages);
  console.log(`Removed "${pkg}" from extensions config.`);
  console.log("Restart the daemon (`volute restart`) to unload the extension.");
}
