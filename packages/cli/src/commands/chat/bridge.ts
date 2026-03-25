import { command, subcommands } from "../../lib/command.js";
import { daemonFetch } from "../../lib/daemon-client.js";

const bridgeAddCmd = command({
  name: "volute chat bridge add",
  description: "Enable a bridge with a default mind",
  args: [
    {
      name: "platform",
      required: true,
      description: "Bridge platform (e.g. discord, slack, telegram)",
    },
  ],
  flags: {
    "default-mind": { type: "string", description: "Mind to route DMs to (required)" },
  },
  run: async ({ args, flags }) => {
    const platform = args.platform!;
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
  },
});

const bridgeRemoveCmd = command({
  name: "volute chat bridge remove",
  description: "Disable a bridge",
  args: [{ name: "platform", required: true, description: "Bridge platform to remove" }],
  flags: {},
  run: async ({ args }) => {
    const platform = args.platform!;

    const res = await daemonFetch(`/api/bridges/${encodeURIComponent(platform)}`, {
      method: "DELETE",
    });

    if (!res.ok) {
      console.error(`Failed to remove bridge: ${res.status}`);
      process.exit(1);
    }

    console.log(`Bridge ${platform} removed.`);
  },
});

const bridgeListCmd = command({
  name: "volute chat bridge list",
  description: "Show all bridges and their status",
  args: [],
  flags: {},
  run: async () => {
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
  },
});

const bridgeMapCmd = command({
  name: "volute chat bridge map",
  description: "Map an external channel to a Volute channel",
  args: [
    { name: "target", required: true, description: "External channel (platform:channel)" },
    { name: "volute-channel", required: true, description: "Volute channel name" },
  ],
  flags: {},
  run: async ({ args }) => {
    const target = args.target!;
    const voluteChannel = args["volute-channel"]!;

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
  },
});

const bridgeUnmapCmd = command({
  name: "volute chat bridge unmap",
  description: "Remove a channel mapping",
  args: [{ name: "target", required: true, description: "External channel (platform:channel)" }],
  flags: {},
  run: async ({ args }) => {
    const target = args.target!;

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
  },
});

const bridgeMappingsCmd = command({
  name: "volute chat bridge mappings",
  description: "List channel mappings",
  args: [{ name: "platform", description: "Filter by platform" }],
  flags: {},
  run: async ({ args }) => {
    const platform = args.platform;

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
  },
});

const cmd = subcommands({
  name: "volute chat bridge",
  description: "Manage platform bridges",
  commands: {
    add: { description: "Enable a bridge with a default mind", run: bridgeAddCmd.execute },
    remove: { description: "Disable a bridge", run: bridgeRemoveCmd.execute },
    list: { description: "Show all bridges and their status", run: bridgeListCmd.execute },
    map: { description: "Map an external channel to a Volute channel", run: bridgeMapCmd.execute },
    unmap: { description: "Remove a channel mapping", run: bridgeUnmapCmd.execute },
    mappings: { description: "List channel mappings", run: bridgeMappingsCmd.execute },
  },
});

export const run = cmd.execute;
