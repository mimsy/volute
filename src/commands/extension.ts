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
  const res = await daemonFetch("/api/extensions/all");
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
    source: string;
    enabled: boolean;
  }>;

  if (extensions.length === 0) {
    console.log("No extensions found.");
    return;
  }

  console.log("Extensions:\n");
  for (const ext of extensions) {
    const status = ext.enabled ? "enabled" : "disabled";
    console.log(`  ${ext.id} — ${ext.name} v${ext.version} (${ext.source}, ${status})`);
    if (ext.description) console.log(`    ${ext.description}`);
  }
}

async function installExtension(args: string[]) {
  const pkg = args[0];
  if (!pkg) {
    console.error("Usage: volute extension install <package>");
    process.exit(1);
  }

  console.log(`Installing "${pkg}"...`);
  const res = await daemonFetch("/api/extensions/install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ package: pkg }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: "Unknown error" }))) as {
      error: string;
    };
    console.error(`Failed to install "${pkg}": ${body.error}`);
    process.exit(1);
  }

  console.log(`Installed "${pkg}".`);
  console.log("Restart the daemon (`volute restart`) to load the extension.");
}

async function uninstallExtension(args: string[]) {
  const pkg = args[0];
  if (!pkg) {
    console.error("Usage: volute extension uninstall <package>");
    process.exit(1);
  }

  const res = await daemonFetch(`/api/extensions/uninstall/${encodeURIComponent(pkg)}`, {
    method: "DELETE",
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: "Unknown error" }))) as {
      error: string;
    };
    console.error(`Failed to uninstall "${pkg}": ${body.error}`);
    process.exit(1);
  }

  console.log(`Removed "${pkg}".`);
  console.log("Restart the daemon (`volute restart`) to unload the extension.");
}
