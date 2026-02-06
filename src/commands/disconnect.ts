import { daemonFetch } from "../lib/daemon-client.js";

export async function run(args: string[]) {
  const type = args[0];
  const name = args[1];

  if (!type || !name) {
    console.error("Usage: volute disconnect <type> <agent>");
    process.exit(1);
  }

  const res = await daemonFetch(`/api/agents/${name}/connectors/${type}`, {
    method: "DELETE",
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Unknown error" }));
    console.error(`Failed to stop ${type} connector: ${(body as { error: string }).error}`);
    process.exit(1);
  }

  console.log(`${type} connector for ${name} stopped.`);
}
