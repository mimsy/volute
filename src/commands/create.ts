import { parseArgs } from "../lib/parse-args.js";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    template: { type: "string" },
  });

  const name = positional[0];
  const template = flags.template ?? "agent-sdk";

  if (!name) {
    console.error("Usage: volute agent create <name> [--template <name>]");
    process.exit(1);
  }

  const { daemonFetch } = await import("../lib/daemon-client.js");
  const { getClient, urlOf } = await import("../lib/api-client.js");
  const client = getClient();

  const res = await daemonFetch(urlOf(client.api.agents.$url()), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, template }),
  });

  const data = (await res.json()) as {
    ok?: boolean;
    error?: string;
    name?: string;
    port?: number;
    message?: string;
  };

  if (!res.ok) {
    console.error(data.error ?? "Failed to create agent");
    process.exit(1);
  }

  console.log(`\n${data.message ?? `Created agent: ${data.name} (port ${data.port})`}`);
  console.log(`\n  volute agent start ${data.name ?? name}`);
}
