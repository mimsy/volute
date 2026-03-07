import { parseArgs } from "../lib/parse-args.js";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    template: { type: "string" },
    skills: { type: "string" },
  });

  const name = positional[0];
  const template = flags.template ?? "claude";

  if (!name) {
    console.error("Usage: volute mind create <name> [--template <name>] [--skills <list|none>]");
    process.exit(1);
  }

  const skills = flags.skills === "none" ? [] : flags.skills ? flags.skills.split(",") : undefined;

  const { daemonFetch } = await import("../lib/daemon-client.js");
  const { getClient, urlOf } = await import("../lib/api-client.js");
  const client = getClient();

  const res = await daemonFetch(urlOf(client.api.minds.$url()), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, template, skills }),
  });

  const data = (await res.json()) as {
    ok?: boolean;
    error?: string;
    name?: string;
    port?: number;
    message?: string;
  };

  if (!res.ok) {
    console.error(data.error ?? "Failed to create mind");
    process.exit(1);
  }

  console.log(`\n${data.message ?? `Created mind: ${data.name} (port ${data.port})`}`);
  console.log(`\n  volute mind start ${data.name ?? name}`);
}
