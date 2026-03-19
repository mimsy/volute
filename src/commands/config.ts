import { parseArgs } from "../lib/parse-args.js";

export async function run(args: string[]) {
  const { positional } = parseArgs(args, {});
  const subcommand = positional[0];

  switch (subcommand) {
    case "models": {
      const { daemonFetch } = await import("../lib/daemon-client.js");
      const res = await daemonFetch("/api/config/models");
      if (!res.ok) {
        console.error(`Failed to fetch models (HTTP ${res.status})`);
        process.exit(1);
      }
      const models = (await res.json()) as {
        id: string;
        name: string;
        provider: string;
        enabled: boolean;
      }[];
      const enabled = models.filter((m) => m.enabled);
      if (enabled.length === 0) {
        console.log("No models enabled.");
        return;
      }
      for (const m of enabled) {
        console.log(`${m.provider}:${m.id}  ${m.name}`);
      }
      break;
    }

    case "providers": {
      const { daemonFetch } = await import("../lib/daemon-client.js");
      const res = await daemonFetch("/api/config/providers");
      if (!res.ok) {
        console.error(`Failed to fetch providers (HTTP ${res.status})`);
        process.exit(1);
      }
      const providers = (await res.json()) as {
        id: string;
        configured: boolean;
      }[];
      const configured = providers.filter((p) => p.configured);
      if (configured.length === 0) {
        console.log("No providers configured.");
        return;
      }
      for (const p of configured) {
        console.log(p.id);
      }
      break;
    }

    case "status": {
      const { daemonFetch } = await import("../lib/daemon-client.js");
      const res = await daemonFetch("/api/config/status");
      if (!res.ok) {
        console.error(`Failed to fetch config (HTTP ${res.status})`);
        process.exit(1);
      }
      const data = (await res.json()) as Record<string, unknown>;
      for (const [key, value] of Object.entries(data)) {
        console.log(`${key}: ${value}`);
      }
      break;
    }

    default:
      console.error("Usage: volute config <models|providers|status>");
      console.error("");
      console.error("  models      List enabled AI models (provider:id format)");
      console.error("  providers   List configured AI providers");
      console.error("  status      Show system configuration");
      process.exit(1);
  }
}
