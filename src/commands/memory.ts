import { parseArgs } from "../lib/parse-args.js";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    port: { type: "number" },
  });

  const port = flags.port ?? 4100;
  const context = positional[0];

  if (!context) {
    console.error('Usage: molt memory --port <port> "<context to remember>"');
    process.exit(1);
  }

  const baseUrl = `http://localhost:${port}`;

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
