import { userInfo } from "os";
import { resolveAgent } from "../lib/registry.js";
import { readNdjson } from "../lib/ndjson.js";
import { getOrCreateConversation, addMessage } from "../lib/conversations.js";

export async function run(args: string[]) {
  const name = args[0];
  const message = args[1];

  if (!name || !message) {
    console.error('Usage: molt send <name> "<message>"');
    process.exit(1);
  }

  const { entry } = resolveAgent(name);
  const baseUrl = `http://localhost:${entry.port}`;
  const sender = userInfo().username;

  const conv = getOrCreateConversation(name, "cli");
  addMessage(conv.id, "user", sender, message);

  const res = await fetch(`${baseUrl}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: [{ type: "text", text: message }],
      channel: "cli",
      sender,
    }),
  });

  if (!res.ok) {
    console.error(`Failed to send message: ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  if (!res.body) {
    console.error("No response body");
    process.exit(1);
  }

  let fullResponse = "";
  for await (const event of readNdjson(res.body)) {
    if (event.type === "text") {
      process.stdout.write(event.content);
      fullResponse += event.content;
    }
    if (event.type === "done") {
      break;
    }
  }

  if (fullResponse) {
    addMessage(conv.id, "assistant", name, fullResponse);
  }

  process.stdout.write("\n");
}
