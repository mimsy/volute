import { daemonFetch } from "../lib/daemon-client.js";

type AgentInfo = {
  name: string;
  port: number;
  status: "running" | "stopped" | "starting";
  channels: Array<{ name: string; status: string }>;
};

export async function run(args: string[]) {
  const name = args[0];

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
      console.log("No agents registered. Create one with: volute create <name>");
      return;
    }

    const nameW = Math.max(4, ...agents.map((a) => a.name.length));
    const portW = Math.max(4, ...agents.map((a) => String(a.port).length));

    console.log(`${"NAME".padEnd(nameW)}  ${"PORT".padEnd(portW)}  STATUS    DISCORD`);

    for (const agent of agents) {
      const discord =
        agent.channels.find((ch) => ch.name === "discord")?.status === "connected"
          ? "connected"
          : "-";
      console.log(
        `${agent.name.padEnd(nameW)}  ${String(agent.port).padEnd(portW)}  ${agent.status.padEnd(8)}  ${discord}`,
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
}
