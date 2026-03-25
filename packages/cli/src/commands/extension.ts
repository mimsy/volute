import { subcommands } from "../lib/command.js";
import { daemonFetch } from "../lib/daemon-client.js";

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

const cmd = subcommands({
  name: "volute extension",
  description: "Manage extensions",
  commands: {
    list: {
      description: "List installed extensions",
      run: async () => listExtensions(),
    },
    install: {
      description: "Install a third-party extension",
      run: installExtension,
    },
    uninstall: {
      description: "Uninstall a third-party extension",
      run: uninstallExtension,
    },
  },
});

export const run = cmd.execute;
