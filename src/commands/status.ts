import { daemonFetch } from "../lib/daemon-client.js";

type VariantInfo = {
  name: string;
  port: number;
  status: "running" | "stopped" | "starting";
};

type AgentInfo = {
  name: string;
  port: number;
  status: "running" | "stopped" | "starting";
  channels: Array<{ name: string; status: string }>;
  variants?: VariantInfo[];
};

export async function run(args: string[]) {
  const name = args[0] || process.env.VOLUTE_AGENT;

  if (!name) {
    // List all agents
    const res = await daemonFetch("/api/agents");
    if (!res.ok) {
      const data = (await res.json()) as { error?: string };
      console.error(data.error ?? `Failed to get status: ${res.status}`);
      process.exit(1);
    }
    const agents = (await res.json()) as AgentInfo[];

    if (agents.length === 0) {
      console.log("No agents registered. Create one with: volute agent create <name>");
      return;
    }

    const nameW = Math.max(4, ...agents.map((a) => a.name.length));
    const portW = Math.max(4, ...agents.map((a) => String(a.port).length));

    console.log(`${"NAME".padEnd(nameW)}  ${"PORT".padEnd(portW)}  STATUS    CONNECTORS`);

    for (const agent of agents) {
      const connected = agent.channels
        .filter((ch) => ch.status === "connected")
        .map((ch) => ch.name);
      const connectors = connected.length > 0 ? connected.join(", ") : "-";
      console.log(
        `${agent.name.padEnd(nameW)}  ${String(agent.port).padEnd(portW)}  ${agent.status.padEnd(8)}  ${connectors}`,
      );
    }
    return;
  }

  // Single agent status
  const res = await daemonFetch(`/api/agents/${encodeURIComponent(name)}`);

  if (!res.ok) {
    const data = (await res.json()) as { error?: string };
    console.error(data.error || `Failed to get status for ${name}`);
    process.exit(1);
  }

  const agent = (await res.json()) as AgentInfo;

  console.log(`Agent: ${agent.name}`);
  console.log(`Port: ${agent.port}`);
  console.log(`Status: ${agent.status}`);

  for (const ch of agent.channels) {
    console.log(`${ch.name}: ${ch.status}`);
  }

  if (agent.variants && agent.variants.length > 0) {
    console.log("");
    console.log("Variants:");
    for (const v of agent.variants) {
      console.log(`  ${v.name}  port=${v.port}  ${v.status}`);
    }
  }
}
