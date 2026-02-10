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

  const agentSelf = process.env.VOLUTE_AGENT;
  const sender = agentSelf || userInfo().username;
  const channel = agentSelf ? "agent" : "cli";

  const res = await daemonFetch(`/api/agents/${encodeURIComponent(name)}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: [{ type: "text", text: message }],
      channel,
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
    } else if (event.type === "tool_use") {
      const args =
        event.input && typeof event.input === "object"
          ? (event.input as Record<string, unknown>)
          : null;
      const val = args?.path ?? args?.command ?? args?.query ?? args?.url;
      const summary =
        typeof val === "string" ? ` ${val.length > 60 ? `${val.slice(0, 57)}...` : val}` : "";
      process.stderr.write(`[${event.name}${summary}]\n`);
    }
    if (event.type === "done") {
      break;
    }
  }

  process.stdout.write("\n");
}
