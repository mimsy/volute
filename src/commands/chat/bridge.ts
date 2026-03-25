import { subcommands } from "../../lib/command.js";
import { daemonFetch } from "../../lib/daemon-client.js";
import { parseArgs } from "../../lib/parse-args.js";

async function bridgeAdd(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    "default-mind": { type: "string" },
  });
  const platform = positional[0];

  if (!platform) {
    console.error("Usage: volute chat bridge add <platform> --default-mind <name>");
    process.exit(1);
  }

  const defaultMind = flags["default-mind"];
  if (!defaultMind) {
    console.error("--default-mind is required (mind to route DMs to)");
    process.exit(1);
  }

  const res = await daemonFetch(`/api/bridges/${encodeURIComponent(platform)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ defaultMind }),
  });

  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      missing?: { name: string; description: string }[];
    };
    if (data.error === "missing_env" && data.missing) {
      console.error(`Missing required environment variables:`);
      for (const v of data.missing) {
        console.error(`  ${v.name} — ${v.description}`);
      }
      console.error(`\nSet them with: volute env set <VAR> <value>`);
    } else {
      console.error(data.error ?? `Failed to add bridge: ${res.status}`);
    }
    process.exit(1);
  }

  console.log(`Bridge ${platform} enabled.`);
}

async function bridgeRemove(args: string[]) {
  const platform = args[0];
  if (!platform) {
    console.error("Usage: volute chat bridge remove <platform>");
    process.exit(1);
  }

  const res = await daemonFetch(`/api/bridges/${encodeURIComponent(platform)}`, {
    method: "DELETE",
  });

  if (!res.ok) {
    console.error(`Failed to remove bridge: ${res.status}`);
    process.exit(1);
  }

  console.log(`Bridge ${platform} removed.`);
}

async function bridgeList() {
  const res = await daemonFetch("/api/bridges");
  if (!res.ok) {
    console.error(`Failed to list bridges: ${res.status}`);
    process.exit(1);
  }

  const bridges = (await res.json()) as {
    platform: string;
    displayName: string;
    enabled: boolean;
    running: boolean;
    defaultMind: string;
  }[];

  if (bridges.length === 0) {
    console.log("No bridges configured. Use 'volute chat bridge add <platform>' to set one up.");
    return;
  }

  for (const b of bridges) {
    const status = b.running ? "running" : b.enabled ? "stopped" : "disabled";
    console.log(`  ${b.displayName} (${b.platform})  ${status}  default: ${b.defaultMind}`);
  }
}

async function bridgeMap(args: string[]) {
  const target = args[0];
  const voluteChannel = args[1];

  if (!target || !voluteChannel) {
    console.error("Usage: volute chat bridge map <platform>:<channel> <volute-channel>");
    process.exit(1);
  }

  const colonIdx = target.indexOf(":");
  if (colonIdx < 1) {
    console.error("Target must be in format platform:channel (e.g. discord:my-server/general)");
    process.exit(1);
  }

  const platform = target.slice(0, colonIdx);
  const externalChannel = target.slice(colonIdx + 1);

  const res = await daemonFetch(`/api/bridges/${encodeURIComponent(platform)}/mappings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ externalChannel, voluteChannel }),
  });

  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    console.error(data.error ?? `Failed to set mapping: ${res.status}`);
    process.exit(1);
  }

  console.log(`Mapped ${platform}:${externalChannel} → ${voluteChannel}`);
}

async function bridgeUnmap(args: string[]) {
  const target = args[0];
  if (!target) {
    console.error("Usage: volute chat bridge unmap <platform>:<channel>");
    process.exit(1);
  }

  const colonIdx = target.indexOf(":");
  if (colonIdx < 1) {
    console.error("Target must be in format platform:channel");
    process.exit(1);
  }

  const platform = target.slice(0, colonIdx);
  const externalChannel = target.slice(colonIdx + 1);

  const res = await daemonFetch(
    `/api/bridges/${encodeURIComponent(platform)}/mappings/${encodeURIComponent(externalChannel)}`,
    { method: "DELETE" },
  );

  if (!res.ok) {
    console.error(`Failed to remove mapping: ${res.status}`);
    process.exit(1);
  }

  console.log(`Removed mapping for ${platform}:${externalChannel}`);
}

async function bridgeMappings(args: string[]) {
  const platform = args[0];

  if (platform) {
    const res = await daemonFetch(`/api/bridges/${encodeURIComponent(platform)}/mappings`);
    if (!res.ok) {
      console.error(`Failed to get mappings: ${res.status}`);
      process.exit(1);
    }

    const mappings = (await res.json()) as Record<string, string>;
    if (Object.keys(mappings).length === 0) {
      console.log(`No mappings for ${platform}.`);
      return;
    }

    for (const [external, volute] of Object.entries(mappings)) {
      console.log(`  ${platform}:${external} → ${volute}`);
    }
  } else {
    // List all bridges' mappings
    const res = await daemonFetch("/api/bridges");
    if (!res.ok) {
      console.error(`Failed to list bridges: ${res.status}`);
      process.exit(1);
    }

    const bridges = (await res.json()) as {
      platform: string;
      channelMappings: Record<string, string>;
    }[];

    let found = false;
    for (const b of bridges) {
      for (const [external, volute] of Object.entries(b.channelMappings)) {
        console.log(`  ${b.platform}:${external} → ${volute}`);
        found = true;
      }
    }
    if (!found) {
      console.log("No mappings configured.");
    }
  }
}

const cmd = subcommands({
  name: "volute chat bridge",
  description: "Manage platform bridges",
  commands: {
    add: { description: "Enable a bridge with a default mind", run: bridgeAdd },
    remove: { description: "Disable a bridge", run: bridgeRemove },
    list: { description: "Show all bridges and their status", run: (args) => bridgeList() },
    map: { description: "Map an external channel to a Volute channel", run: bridgeMap },
    unmap: { description: "Remove a channel mapping", run: bridgeUnmap },
    mappings: { description: "List channel mappings", run: bridgeMappings },
  },
});

export const run = cmd.execute;
