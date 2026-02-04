import { resolveAgent } from "../lib/registry.js";
import { readNdjson } from "../lib/ndjson.js";

export async function run(args: string[]) {
  const name = args[0];
  const message = args[1];

  if (!name || !message) {
    console.error('Usage: molt send <name> "<message>"');
    process.exit(1);
  }

  const { entry } = resolveAgent(name);
  const baseUrl = `http://localhost:${entry.port}`;

  const res = await fetch(`${baseUrl}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: [{ type: "text", text: message }] }),
  });

  if (!res.ok) {
    console.error(`Failed to send message: ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  if (!res.body) {
    console.error("No response body");
    process.exit(1);
  }

  for await (const event of readNdjson(res.body)) {
    if (event.type === "text") {
      process.stdout.write(event.content);
    }
    if (event.type === "done") {
      break;
    }
  }

  process.stdout.write("\n");
}
