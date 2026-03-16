import { daemonFetch } from "../../lib/daemon-client.js";
import { parseArgs } from "../../lib/parse-args.js";
import { resolveMindName } from "../../lib/resolve-mind-name.js";

type Conversation = {
  id: string;
  title: string | null;
  type: string;
  name: string | null;
};

async function resolveConversationId(mindName: string, input: string): Promise<string> {
  // If it looks like a UUID, use it directly
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input)) {
    return input;
  }

  // Fetch conversation list and try to match
  const res = await daemonFetch(`/api/minds/${encodeURIComponent(mindName)}/conversations`);
  if (!res.ok) {
    return input; // Fall through to the original behavior
  }

  const convs = (await res.json()) as Conversation[];

  // Strip leading @ or # for matching
  const cleaned = input.replace(/^[@#]/, "");
  const lower = cleaned.toLowerCase();

  // Try channel name match (e.g. "#system" or "system")
  const channelMatch = convs.find((c) => c.type === "channel" && c.name?.toLowerCase() === lower);
  if (channelMatch) return channelMatch.id;

  // Try DM match by title (e.g. "psamiton, iris" or just "psamiton")
  const titleMatch = convs.find((c) => c.title?.toLowerCase() === lower);
  if (titleMatch) return titleMatch.id;

  // Try partial DM match — input matches any participant name in the title
  const dmMatch = convs.find(
    (c) =>
      c.type === "dm" &&
      c.title
        ?.toLowerCase()
        .split(/,\s*/)
        .some((name) => name === lower),
  );
  if (dmMatch) return dmMatch.id;

  // Try UUID prefix match
  const prefixMatch = convs.find((c) => c.id.startsWith(input));
  if (prefixMatch) return prefixMatch.id;

  return input; // Fall through
}

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    mind: { type: "string" },
    limit: { type: "number" },
  });

  const input = positional[0];
  if (!input) {
    console.error("Usage: volute chat read <conversation> [--limit N] [--mind <name>]");
    process.exit(1);
  }

  const mindName = resolveMindName(flags);
  const conversationId = await resolveConversationId(mindName, input);
  const limit = String(flags.limit ?? 50);

  const res = await daemonFetch(
    `/api/minds/${encodeURIComponent(mindName)}/conversations/${encodeURIComponent(conversationId)}/messages?limit=${limit}`,
  );
  if (!res.ok) {
    console.error(`Failed to read conversation: ${res.status}`);
    process.exit(1);
  }

  const data = (await res.json()) as {
    items: {
      role: string;
      sender_name: string | null;
      content: string | { type: string; text?: string }[];
      created_at: string;
    }[];
  };

  if (!Array.isArray(data.items)) {
    console.error("Unexpected response format from server");
    process.exit(1);
  }

  for (const msg of data.items) {
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
