import { userInfo } from "node:os";
import { daemonFetch } from "../lib/daemon-client.js";
import { readNdjson } from "../lib/ndjson.js";

export async function run(args: string[]) {
  const name = args[0];
  const message = args[1];

  if (!name || !message) {
    console.error('Usage: volute send <name> "<message>"');
    process.exit(1);
  }

  const sender = userInfo().username;

  const res = await daemonFetch(`/api/agents/${encodeURIComponent(name)}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: [{ type: "text", text: message }],
      channel: "cli",
      sender,
    }),
  });

  if (!res.ok) {
    const data = (await res.json()) as { error?: string };
    console.error(data.error ?? `Failed to send message: ${res.status}`);
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
