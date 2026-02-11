import { userInfo } from "node:os";
import { daemonFetch } from "../lib/daemon-client.js";
import { summarizeTool } from "../lib/format-tool.js";

export async function run(args: string[]) {
  const name = args[0];
  const message = args[1];

  if (!name || !message) {
    console.error('Usage: volute message send <name> "<message>"');
    process.exit(1);
  }

  const agentSelf = process.env.VOLUTE_AGENT;
  const sender = agentSelf || userInfo().username;

  const res = await daemonFetch(`/api/agents/${encodeURIComponent(name)}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, sender }),
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

  // Parse SSE stream
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      if (event.type === "text") {
        process.stdout.write(event.content as string);
      } else if (event.type === "tool_use") {
        process.stderr.write(`${summarizeTool(event.name as string, event.input)}\n`);
      }
      if (event.type === "done") {
        process.stdout.write("\n");
        return;
      }
    }
  }

  process.stdout.write("\n");
}
