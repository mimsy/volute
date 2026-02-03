import { parseArgs } from "../lib/parse-args.js";

export async function run(args: string[]) {
  const { flags } = parseArgs(args, {
    port: { type: "number" },
  });

  const port = flags.port ?? 4100;
  const url = `http://localhost:${port}/health`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`Health check failed: ${res.status} ${res.statusText}`);
      process.exit(1);
    }
    const data = (await res.json()) as { name: string; version: string; status: string };
    console.log(`Agent: ${data.name} v${data.version}`);
    console.log(`Status: ${data.status}`);
  } catch (err) {
    console.error(`Could not connect to agent at ${url}`);
    console.error("Is the agent running? Try: molt start");
    process.exit(1);
  }
}
