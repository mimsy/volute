import { daemonFetch } from "../../lib/daemon-client.js";
import { parseArgs } from "../../lib/parse-args.js";
import { resolveMindName } from "../../lib/resolve-mind-name.js";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    mind: { type: "string" },
    limit: { type: "string" },
  });

  const conversationId = positional[0];
  if (!conversationId) {
    console.error("Usage: volute chat read <conversation-id> [--limit N] [--mind <name>]");
    process.exit(1);
  }

  const mindName = resolveMindName(flags);
  const limit = flags.limit ?? "50";

  const res = await daemonFetch(
    `/api/minds/${encodeURIComponent(mindName)}/conversations/${encodeURIComponent(conversationId)}/messages?limit=${limit}`,
  );
  if (!res.ok) {
    console.error(`Failed to read conversation: ${res.status}`);
    process.exit(1);
  }

  const data = (await res.json()) as {
    messages: {
      role: string;
      sender_name: string | null;
      content: string | { type: string; text?: string }[];
      created_at: string;
    }[];
  };

  for (const msg of data.messages) {
    const sender = msg.sender_name ?? msg.role;
    const text = Array.isArray(msg.content)
      ? msg.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("")
      : msg.content;
    const time = new Date(
      msg.created_at.endsWith("Z") ? msg.created_at : `${msg.created_at}Z`,
    ).toLocaleString();
    console.log(`[${time}] ${sender}: ${text}`);
  }
}
