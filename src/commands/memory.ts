import { resolveAgent } from "../lib/registry.js";

export async function run(args: string[]) {
  const name = args[0];
  const context = args[1];

  if (!name || !context) {
    console.error('Usage: molt memory <name> "<context to remember>"');
    process.exit(1);
  }

  const { entry } = resolveAgent(name);
  const baseUrl = `http://localhost:${entry.port}`;

  const res = await fetch(`${baseUrl}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "update-memory", context }),
  });

  if (!res.ok) {
    console.error(`Failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  console.log("Memory update sent to agent.");
}
