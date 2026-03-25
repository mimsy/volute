import { subcommands } from "../lib/command.js";

async function listModels() {
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
}

async function listProviders() {
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
}

async function showStatus() {
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
}

const cmd = subcommands({
  name: "volute config",
  description: "View system configuration",
  commands: {
    models: {
      description: "List enabled AI models",
      run: async () => listModels(),
    },
    providers: {
      description: "List configured AI providers",
      run: async () => listProviders(),
    },
    status: {
      description: "Show system configuration",
      run: async () => showStatus(),
    },
  },
});

export const run = cmd.execute;
